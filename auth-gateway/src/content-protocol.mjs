import { createHash } from 'node:crypto';

const EXPERT_MARKET = '/portal/operation-platform/market';
const SKILL_MARKET = '/v2/operation-platform/market';
const MAX_PAGE_SIZE = 500;
const MAX_IDS = 500;
const ID = /^[a-zA-Z0-9._-]{1,128}$/;

function result(data, status = 200, code = 0, msg = 'success') {
  return { status, body: { code, msg, data } };
}

function failure(status, code, msg) {
  return result(null, status, code, msg);
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > max) return undefined;
  return number;
}

function timestamp(value) {
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) ? number : 0;
}

function metadata(record) {
  return record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
}

function featuredValue(record) {
  const value = metadata(record).featured;
  return typeof value === 'number' && Number.isFinite(value) ? value : value === true ? 1 : 0;
}

function categoryId(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function requestedIds(value, allowNumeric = false) {
  if (!Array.isArray(value) || value.length > MAX_IDS) return undefined;
  const ids = value.map(id => allowNumeric && Number.isSafeInteger(id) && id >= 0 ? String(id) : id);
  if (ids.some(id => typeof id !== 'string' || !ID.test(id))) return undefined;
  return [...new Set(ids)];
}

function namedCategories(records, categories = []) {
  const map = new Map();
  for (const record of records) {
    const id = categoryId(record.categoryId);
    if (!id) continue;
    const entry = map.get(id) ?? { id, name: id, count: 0 };
    entry.count++;
    map.set(id, entry);
  }
  for (const category of categories) {
    const id = categoryId(typeof category === 'object' ? category.id ?? category.categoryId : category);
    const entry = map.get(id);
    if (!entry) continue;
    const name = typeof category === 'object' ? category.name ?? category.label : category;
    entry.name = typeof name === 'object' ? text(name.zh, text(name.en, id)) : text(name, id);
    entry.nameEn = typeof name === 'object' ? text(name.en, entry.name) : entry.name;
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id)).map((category, order) => ({
    id: category.id, name: { zh: category.name, en: category.nameEn ?? category.name },
    name_zh: category.name, name_en: category.nameEn ?? category.name,
    sort_order: order, item_count: category.count,
  }));
}

/** Auth and HTTP parsing belong to the caller. This module only adapts published content. */
export function createContentProtocol({ catalog, publicUrl, signDownload, staticAssetUrl = () => undefined }) {
  if (!catalog?.list || !catalog?.get || !catalog?.categories) throw new TypeError('Content catalog requires list, get and categories');
  const origin = new URL(publicUrl).origin;

  async function list(kind, options = {}) {
    const records = await catalog.list(kind, { keyword: options.keyword, categoryId: options.categoryId, enabledOnly: true });
    if (!Array.isArray(records)) throw new TypeError('Content catalog list must return an array');
    return records.filter(record => record.enabled !== false);
  }

  async function get(kind, id, version) {
    if (!ID.test(id)) return undefined;
    const record = await catalog.get(kind, id, { version: version === 'latest' ? undefined : version });
    return record?.enabled === false ? undefined : record;
  }

  function icon(record) {
    const meta = metadata(record);
    const file = record.files?.find(file => file.name === meta.iconFile || file.path === meta.iconPath);
    return file?.contentType?.startsWith('image/') ? text(staticAssetUrl(file.path)) : '';
  }

  async function download(record, account) {
    if (!record.packagePath) throw Object.assign(new Error('内容没有发布安装包'), { code: 'CONTENT_PACKAGE_MISSING', status: 409 });
    if (typeof signDownload !== 'function') throw Object.assign(new Error('内容下载尚未配置'), { code: 'CONTENT_DOWNLOAD_NOT_CONFIGURED', status: 501 });
    const signed = await signDownload(record, account);
    if (!(typeof signed === 'string' || signed instanceof URL || typeof signed?.url === 'string')) {
      throw Object.assign(new Error('内容下载地址未生成'), { code: 'CONTENT_DOWNLOAD_NOT_CONFIGURED', status: 501 });
    }
    const url = new URL(typeof signed === 'string' || signed instanceof URL ? String(signed) : signed?.url, publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw Object.assign(new Error('内容下载地址必须使用当前服务 origin'), { code: 'CONTENT_DOWNLOAD_ORIGIN', status: 500 });
    }
    const expiry = typeof signed === 'object' && !(signed instanceof URL) ? signed.expiresAt ?? signed.expiresAtSeconds : undefined;
    return { url: url.href, expiresAt: typeof expiry === 'number' ? Math.floor(expiry > 1e12 ? expiry / 1000 : expiry) : undefined };
  }

  async function expert(record, account) {
    const meta = metadata(record);
    const signed = await download(record, account);
    return {
      expert_id: record.id, source_id: record.id, source: 'builtin', namespace: 'private',
      name: text(meta.pluginName, record.id), plugin_name: text(meta.pluginName, record.id), version: record.version,
      display_name_zh: text(meta.nameZh, record.name), display_name_en: text(meta.nameEn, record.name),
      profession_zh: text(meta.professionZh), profession_en: text(meta.professionEn),
      description_zh: text(meta.descriptionZh, record.description), description_en: text(meta.descriptionEn, record.description),
      expert_type: meta.expertType === 'team' ? 'team' : 'agent',
      categories: record.categoryId ? [record.categoryId] : [],
      categories_detail: record.categoryId ? [{ id: record.categoryId }] : [],
      tags_zh: strings(meta.tagsZh ?? record.tags), tags_en: strings(meta.tagsEn ?? record.tags),
      quick_prompts: strings(meta.quickPrompts), icon: icon(record),
      download_url: signed.url, created_at: record.publishedAt, updated_at: record.updatedAt,
    };
  }

  function skill(record) {
    const meta = metadata(record);
    return {
      id: record.id, skill_id: record.id, name: text(meta.skillName, record.id), version: record.version,
      display_name: record.name, display_name_zh: text(meta.nameZh, record.name), display_name_en: text(meta.nameEn, record.name),
      description: text(meta.nameZh, record.name), description_zh: text(meta.descriptionZh, record.description), description_en: text(meta.descriptionEn, record.description),
      categories: record.categoryId ? [record.categoryId] : [],
      tag_zh: strings(meta.tagsZh ?? record.tags), tag_en: strings(meta.tagsEn ?? record.tags),
      examples_zh: strings(meta.examplesZh), examples_en: strings(meta.examplesEn),
      icon: icon(record), source: 'private', featured: featuredValue(record),
      featured_order: Number.isFinite(meta.featuredOrder) ? meta.featuredOrder : 0,
    };
  }

  async function page(kind, request) {
    const body = request.body ?? {};
    const page = positiveInteger(body.page, 1);
    const size = positiveInteger(body.page_size, 20, MAX_PAGE_SIZE);
    if (page === undefined || size === undefined) return failure(400, 'INVALID_PAGINATION', 'page 和 page_size 必须是有效正整数');
    const categoryIds = strings(body.categories).filter(id => id !== 'all');
    if (body.category_id !== undefined) categoryIds.push(String(body.category_id));
    const keyword = text(body.keyword).trim();
    let records = await list(kind, { keyword, categoryId: categoryIds.length === 1 ? categoryIds[0] : undefined });
    if (categoryIds.length > 1) records = records.filter(record => categoryIds.includes(String(record.categoryId)));
    if (kind === 'expert' && body.expert_type) records = records.filter(record => (metadata(record).expertType ?? 'agent') === body.expert_type);
    if (kind === 'skill' && Array.isArray(body.featured)) {
      const featured = new Set(body.featured.filter(value => typeof value === 'number' && Number.isFinite(value)));
      if (featured.size) records = records.filter(record => featured.has(featuredValue(record)));
    }
    const total = records.length;
    records = records.slice((page - 1) * size, page * size);
    const items = kind === 'expert' ? await Promise.all(records.map(record => expert(record, request.account))) : records.map(skill);
    return result(kind === 'expert' ? { items, total, page, page_size: size } : { skills: items, total_count: total });
  }

  async function byIds(kind, request) {
    const ids = requestedIds(request.body?.[kind === 'expert' ? 'expert_ids' : 'skill_ids'], kind === 'skill');
    if (!ids) return failure(400, 'INVALID_CONTENT_IDS', '内容 id 列表格式无效');
    const records = (await Promise.all(ids.map(id => get(kind, id)))).filter(Boolean);
    const items = kind === 'expert' ? await Promise.all(records.map(record => expert(record, request.account))) : records.map(skill);
    return result(kind === 'expert' ? { items } : { skills: items, total_count: items.length });
  }

  async function categories(kind) {
    const records = await list(kind);
    return namedCategories(records, await catalog.categories(kind));
  }

  async function downloadUrl(kind, request) {
    const id = request.body?.[`${kind}_id`];
    if (typeof id !== 'string' || !ID.test(id)) return failure(400, 'INVALID_CONTENT_ID', '内容 id 格式无效');
    const requestedVersion = request.body?.version;
    if (requestedVersion !== undefined && (typeof requestedVersion !== 'string' || requestedVersion.length > 128
      || (requestedVersion !== 'latest' && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(requestedVersion)))) {
      return failure(400, 'INVALID_CONTENT_VERSION', '内容版本格式无效');
    }
    const record = await get(kind, id, text(request.body?.version) || undefined);
    if (!record) return failure(404, 'CONTENT_NOT_FOUND', '内容或指定版本未发布');
    const signed = await download(record, request.account);
    if (kind === 'expert') return result({ download_url: signed.url });
    return result({ download_url: signed.url, expires_at: signed.expiresAt ?? 0,
      filename: `${record.id}-${record.version}.zip`, skill_id: record.id, version: record.version });
  }

  async function getExpertManifest() {
    const records = (await list('expert')).filter(record => metadata(record).public === true && metadata(record).allowedUsers === undefined);
    const experts = records.map(record => {
      const meta = metadata(record);
      return { id: record.id, categoryId: record.categoryId ?? '',
        name: { zh: text(meta.nameZh, record.name), en: text(meta.nameEn, record.name) },
        description: { zh: text(meta.descriptionZh, record.description), en: text(meta.descriptionEn, record.description) },
        plugin: text(meta.pluginName, record.id), version: record.version,
        expertType: meta.expertType === 'team' ? 'team' : 'agent', agentName: text(meta.agentName, record.id),
        avatar: icon(record), updatedAt: record.updatedAt };
    });
    const publicCategories = records.map(record => ({ id: record.categoryId,
      name: text(metadata(record).categoryName, categoryId(record.categoryId)) }));
    const categoryItems = namedCategories(records, publicCategories).map(category => ({
      id: category.id, name: category.name, expertCount: category.item_count, order: category.sort_order,
    }));
    const version = createHash('sha256').update(JSON.stringify({ experts, categories: categoryItems })).digest('hex');
    const lastUpdated = new Date(Math.max(0, ...records.map(record => timestamp(record.updatedAt)))).toISOString();
    return { version, lastUpdated, categories: categoryItems, experts, statistics: { totalExperts: experts.length } };
  }

  async function dispatch(request) {
    const method = text(request.method).toUpperCase();
    const path = request.path;
    if (method === 'POST' && path === `${EXPERT_MARKET}/expert/list`) return page('expert', request);
    if (method === 'POST' && path === `${EXPERT_MARKET}/expert/get-by-ids`) return byIds('expert', request);
    if (method === 'GET' && path === `${EXPERT_MARKET}/expert-categories`) return result({ items: await categories('expert') });
    if (method === 'POST' && path === `${EXPERT_MARKET}/expert/download-url`) return downloadUrl('expert', request);
    if (method === 'POST' && path === '/api/v2/open-platform/featured') {
      const records = (await list('expert')).filter(record => featuredValue(record) > 0);
      return result({ scenes: records.length ? [{ id: 'private-featured', name_zh: '推荐专家', name_en: 'Featured experts',
        experts: await Promise.all(records.map(record => expert(record, request.account))) }] : [] });
    }
    if (method === 'POST' && path === `${SKILL_MARKET}/skill/list`) return page('skill', request);
    if (method === 'POST' && path === `${SKILL_MARKET}/skill/get-by-ids`) return byIds('skill', request);
    if (method === 'GET' && path === `${SKILL_MARKET}/categories`) {
      const type = request.query instanceof URLSearchParams ? request.query.get('type') : request.query?.type;
      if (type && type !== 'skill') return undefined;
      const items = await categories('skill');
      return result({ type: 'skill', total: items.length, items });
    }
    if (method === 'POST' && path === `${SKILL_MARKET}/skill/download-url`) return downloadUrl('skill', request);
    return undefined;
  }

  return { dispatch, getExpertManifest };
}
