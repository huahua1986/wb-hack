import fs from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { tokenHash } from './credentials.mjs';
import { createContentProtocol } from './content-protocol.mjs';
import { buildConnectorMarketplace } from './connector-catalog.mjs';
import { buildZip } from './package-archive.mjs';

const apiPrefixes = ['/portal/operation-platform/market/expert', '/v2/operation-platform/market/skill'];
const packagePattern = /^\/content\/packages\/(expert|skill|connector)\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9%.+_-]{1,128})$/;
const downloadLifetime = 900;
const fail = (status, message) => Object.assign(new Error(message), { status });
const publicRecord = record => record?.metadata?.public === true && record.metadata.allowedUsers === undefined;

function visible(record, account) {
  if (!record || record.enabled === false) return false;
  const users = record.metadata?.allowedUsers;
  return users === undefined || (Array.isArray(users) && users.some(user => user === account?.uid || user === account?.username));
}

function sendJson(res, value, status = 200, head = false) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
  res.end(head ? undefined : data);
}

async function sendAsset(req, res, asset) {
  const etag = '"' + asset.sha256 + '"';
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Content-Disposition', 'attachment; filename="' + asset.filename + '"');
  if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
  let start = 0, end = asset.size - 1, status = 200;
  if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) throw fail(416, '无效的下载范围');
    if (match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
    else { const suffix = Number(match[2]); if (!suffix) throw fail(416, '无效的下载范围'); start = Math.max(0, asset.size - suffix); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= asset.size) {
      res.setHeader('Content-Range', 'bytes */' + asset.size); throw fail(416, '下载范围超出文件大小');
    }
    status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${asset.size}`);
  }
  let fd;
  if (!asset.buffer && req.method !== 'HEAD' && asset.size) {
    fd = fs.openSync(asset.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== asset.size) { fs.closeSync(fd); throw fail(500, '安装包完整性校验失败'); }
  }
  res.setHeader('Content-Length', end >= start ? end - start + 1 : 0);
  res.writeHead(status);
  if (req.method === 'HEAD' || asset.size === 0) { res.end(); return; }
  if (asset.buffer) { res.end(asset.buffer.subarray(start, end + 1)); return; }
  await pipeline(fs.createReadStream(asset.absolutePath, { fd, autoClose: true, start, end }), res);
}

export class ContentHttp {
  constructor({ config, store, catalog, now = Date.now }) {
    this.config = config; this.store = store; this.catalog = catalog; this.now = now;
    this.signingKey = createHmac('sha256', store.key).update('workbuddy-private-content-v1').digest();
    this.connectorCache = null;
  }

  scope(account) {
    return {
      list: (kind, options = {}) => {
        if (options.keyword !== undefined && (typeof options.keyword !== 'string' || options.keyword.length > 256)) throw fail(400, '关键词过长');
        if (options.categoryId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.categoryId)) throw fail(400, '无效的分类');
        return this.catalog.list(kind, options).filter(record => visible(record, account));
      },
      get: (kind, id, options) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(id))) return undefined;
        if (options?.version && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(options.version)) throw fail(400, '无效的内容版本');
        const record = this.catalog.get(kind, String(id), options); return visible(record, account) ? record : undefined;
      },
      categories: kind => {
        const categories = new Map();
        for (const item of this.catalog.list(kind).filter(record => visible(record, account))) {
          const entry = categories.get(item.categoryId) || { id: item.categoryId, name: item.metadata.categoryName || item.categoryId, count: 0 };
          entry.count++; categories.set(item.categoryId, entry);
        }
        return [...categories.values()];
      },
    };
  }

  signature(pathname, hash, sessionId, expires) {
    return createHmac('sha256', this.signingKey).update(JSON.stringify([pathname, hash, sessionId, expires])).digest('base64url');
  }

  downloadUrl(record, sessionId) {
    const pathname = `/content/packages/${record.kind}/${record.id}/${encodeURIComponent(record.version)}`;
    const expires = Math.floor(this.now() / 1000) + downloadLifetime;
    const url = new URL(pathname, this.config.publicUrl);
    url.searchParams.set('expires', String(expires)); url.searchParams.set('session', sessionId);
    url.searchParams.set('signature', this.signature(pathname, record.sha256, sessionId, expires));
    return url.href;
  }

  sessionIdentity(req, account) {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    const row = token && this.store.db.prepare('SELECT s.id FROM access_tokens a JOIN sessions s ON s.id=a.session_id WHERE a.hash=? AND s.user_id=? AND a.expires>? AND s.revoked=0 AND s.refresh_expires>?')
      .get(tokenHash(token), account.uid, this.now(), this.now());
    if (!row) throw fail(401, '登录已失效');
    return row.id;
  }

  checkDownload(req, url, record, requireAccount) {
    if (!record) throw fail(404, '内容不存在或已下架');
    if (req.headers.authorization) {
      const account = requireAccount(req);
      if (!visible(record, account)) throw fail(403, '无权下载该内容');
      return account;
    }
    const expiresText = url.searchParams.get('expires'), sessionId = url.searchParams.get('session'), signature = url.searchParams.get('signature');
    if (!/^\d{1,12}$/.test(expiresText || '') || !/^[a-f0-9-]{36}$/.test(sessionId || '') || !/^[A-Za-z0-9_-]{43}$/.test(signature || '')) throw fail(401, '下载需要有效的登录授权');
    const expires = Number(expiresText), now = Math.floor(this.now() / 1000);
    if (expires <= now || expires > now + downloadLifetime) throw fail(401, '下载链接已失效');
    const expected = this.signature(url.pathname, record.sha256, sessionId, expires);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw fail(401, '下载授权无效');
    const user = this.store.db.prepare('SELECT u.id AS uid,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.revoked=0 AND s.refresh_expires>? AND u.disabled=0').get(sessionId, this.now());
    if (!user) throw fail(401, '登录已失效，请重新登录');
    if (!visible(record, user)) throw fail(403, '无权下载该内容');
    return user;
  }

  async connectors() {
    const records = this.catalog.list('connector').filter(publicRecord);
    const files = records.flatMap(record => record.files);
    if (files.length > 5000 || files.reduce((size, file) => size + file.size, 0) > 64 * 1024 * 1024) throw fail(413, '公开连接器目录超过分发上限');
    const key = createHash('sha256').update(JSON.stringify(records.map(record => [record.id, record.version, record.sha256]))).digest('hex');
    if (this.connectorCache?.key === key) return this.connectorCache.value;
    const value = await buildConnectorMarketplace({ records, version: key, publicUrl: this.config.publicUrl,
      buildZip, readAsset: filename => fs.readFileSync(this.catalog.asset(filename).absolutePath) });
    this.connectorCache = { key, value };
    return value;
  }

  publicIcon(pathname) {
    for (const kind of ['expert', 'skill', 'connector']) {
      for (const record of this.catalog.list(kind).filter(publicRecord)) {
        const file = record.files.find(file => file.path === pathname && (file.name === record.metadata.iconFile || file.path === record.metadata.iconPath));
        if (file?.contentType.startsWith('image/')) return this.catalog.asset(pathname);
      }
    }
    return undefined;
  }

  async handle(req, res, { url, requireAccount, readBody }) {
    const route = url.pathname, read = req.method === 'GET' || req.method === 'HEAD';
    if (read && route.startsWith('/content/assets/')) {
      const file = route.slice('/content/assets/'.length);
      const asset = this.publicIcon(file);
      if (!asset) throw fail(404, '图标未发布');
      await sendAsset(req, res, { ...asset, filename: 'icon' }); return true;
    }
    if (read && packagePattern.test(route)) {
      const [, kind, id, encodedVersion] = packagePattern.exec(route);
      let version;
      try { version = decodeURIComponent(encodedVersion); } catch { throw fail(400, '无效的内容版本'); }
      if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version) || version.length > 64) throw fail(400, '无效的内容版本');
      const record = this.catalog.get(kind, id, { version });
      const account = this.checkDownload(req, url, record, requireAccount);
      const asset = this.catalog.asset(record.packagePath);
      await sendAsset(req, res, { ...asset, filename: `${record.id}-${record.version}.${kind === 'expert' ? 'tar.gz' : 'zip'}` });
      this.store.audit('content_package_download', account.username, url.searchParams.get('session'), { actor: 'client' });
      return true;
    }
    if (read && ['/workbuddy/expert-marketplace/expert_center.json', '/workbuddy/expert-marketplace/internalExpert.json', '/workbuddy/expert-marketplace/externalExpert.json'].includes(route)) {
      const published = { list: kind => this.catalog.list(kind).filter(publicRecord),
        get: (kind, id, options) => { const record = this.catalog.get(kind, id, options); return publicRecord(record) ? record : undefined; },
        categories: kind => {
        const ids = new Set(this.catalog.list(kind).filter(publicRecord).map(record => record.categoryId));
        return this.catalog.categories(kind).filter(category => ids.has(category.id));
      } };
      const protocol = createContentProtocol({ catalog: published, publicUrl: this.config.publicUrl });
      const manifest = route.endsWith('/expert_center.json') ? await protocol.getExpertManifest() : { version: '1.0.0', categories: [], experts: [] };
      sendJson(res, manifest, 200, req.method === 'HEAD'); return true;
    }
    if (read && /^\/workbuddy\/expert-marketplace\/bundles\/[A-Za-z0-9._-]+\.tar\.gz$/.test(route)) {
      const name = route.split('/').at(-1).slice(0, -7);
      const record = this.catalog.list('expert').find(record => (record.metadata?.pluginName || record.id) === name && publicRecord(record));
      if (!record) throw fail(404, '未发布可公开下载的专家包');
      await sendAsset(req, res, { ...this.catalog.asset(record.packagePath), filename: name + '.tar.gz' }); return true;
    }
    if (read && route === '/connector-agent-plugins/connector-plugins.zip') {
      const marketplace = await this.connectors();
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      await sendAsset(req, res, { ...marketplace, filename: 'connector-plugins.zip', contentType: 'application/zip' });
      return true;
    }
    const prefix = apiPrefixes.some(prefix => route.startsWith(prefix)) || ['/v2/operation-platform/market/categories', '/api/v2/open-platform/featured'].includes(route);
    if (prefix && ['GET', 'POST'].includes(req.method)) {
      const account = requireAccount(req), sessionId = this.sessionIdentity(req, account);
      const protocol = createContentProtocol({ catalog: this.scope(account), publicUrl: this.config.publicUrl,
        signDownload: record => ({ url: this.downloadUrl(record, sessionId), expiresAt: Math.floor(this.now() / 1000) + downloadLifetime }),
        staticAssetUrl: pathname => this.publicIcon(pathname) ? `${this.config.publicUrl}/content/assets/${pathname}` : undefined });
      const result = await protocol.dispatch({ method: req.method, path: route, query: Object.fromEntries(url.searchParams), body: req.method === 'POST' ? await readBody(req) : {}, account });
      if (!result) throw fail(404, '此内容服务不提供该接口');
      sendJson(res, result.body, result.status || 200); return true;
    }
    return false;
  }
}
