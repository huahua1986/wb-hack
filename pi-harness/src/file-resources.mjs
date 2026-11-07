import path from 'node:path';
import { createHash } from 'node:crypto';

const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const action = operation => ({ created: 'create', modified: 'modify', deleted: 'delete' })[operation] ?? 'modify';
export function unifiedHunks(diff = '') {
  const hunks = []; let current;
  for (const line of diff.split('\n')) {
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (match) {
      current = { oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1), header: match[5].trimStart(), lines: [] };
      hunks.push(current);
    } else if (current && /^[ +\-\\]/.test(line)) current.lines.push(line);
  }
  return hunks;
}
export function nativeChangeFile(change, detail) {
  const hunks = detail?.diffAvailable ? unifiedHunks(detail.diff) : undefined;
  const lines = hunks?.flatMap(h => h.lines) ?? [];
  return { filePath: change.path, action: action(change.operation),
    additions: lines.filter(l => l.startsWith('+')).length, deletions: lines.filter(l => l.startsWith('-')).length,
    ...(hunks ? { hunks, content: detail.afterText ?? '', detailStatus: 'available' }
      : { detailStatus: detail ? 'diff-omitted-size' : 'content-omitted-size' }),
    ...(detail?.binary ? { binary: true } : {}),
    ...(detail?.reason ? { diffStatus: detail.reason === 'text-preview-limit' ? 'timeout' : detail.reason,
      diffReason: detail.reason } : {}) };
}
export function nativeManifest(manifest, details = new Map()) {
  return { id: manifest.turnId, conversationId: manifest.threadId, requestId: manifest.turnId, detailRef: manifest.turnId,
    createdAt: timestamp(manifest.createdAt), files: manifest.changes.filter(c => !c.rolledBack).map(c => nativeChangeFile(c, details.get(c.id))),
    coverage: manifest.coverage, rollbackAvailable: manifest.rollbackAvailable };
}

export const NATIVE_DIFF_INLINE_LIMITS = Object.freeze({ maxBytes: 256 * 1024, maxFiles: 64, maxMs: 1000 });

/** Keep the native latest-file view from borrowing an older turn's diff. */
export async function nativeDiffResources(manifests, readDetail, {
  maxBytes = NATIVE_DIFF_INLINE_LIMITS.maxBytes, maxFiles = NATIVE_DIFF_INLINE_LIMITS.maxFiles,
  maxMs = NATIVE_DIFF_INLINE_LIMITS.maxMs, now = () => performance.now(),
} = {}) {
  for (const [name, value] of Object.entries({ maxBytes, maxFiles, maxMs })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > NATIVE_DIFF_INLINE_LIMITS[name]) throw new TypeError('Invalid native diff preview budget');
  }
  const ordered = [...manifests].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt));
  const latest = new Map(), details = new Map(), excludedPaths = new Set(), diffOmissions = [];
  for (const manifest of ordered) for (const change of manifest.changes) if (!change.rolledBack) latest.set(change.path, change);
  const started = now(); let bytes = 0, reads = 0;
  for (const change of [...latest.values()].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))) {
    let detail;
    if (reads >= maxFiles || now() - started >= maxMs) detail = { reason: 'preview-budget' };
    else { reads++; detail = await readDetail(change); }
    let projected = nativeChangeFile(change, detail);
    if (detail?.diffAvailable && !projected.hunks?.length) detail = { reason: 'no-text-diff' };
    else if (detail?.diffAvailable && bytes + Buffer.byteLength(JSON.stringify(projected)) > maxBytes) detail = { reason: 'preview-budget' };
    projected = nativeChangeFile(change, detail);
    if (!detail?.diffAvailable) {
      const reason = detail?.reason ?? (detail?.binary ? 'binary-file' : 'snapshot-unavailable');
      detail = { ...detail, reason };
      diffOmissions.push({ filePath: change.path, requestId: change.turnId, reason });
      // The native viewer has a per-file size placeholder, but no binary,
      // missing-snapshot or global-budget view. Exclude this path's history so
      // its earlier textual payload cannot become the apparent current diff.
      if (reason !== 'text-preview-limit') excludedPaths.add(change.path);
    } else bytes += Buffer.byteLength(JSON.stringify(projected));
    details.set(change.id, detail);
  }
  return {
    manifests: ordered.map(manifest => nativeManifest({ ...manifest,
      changes: manifest.changes.filter(change => !excludedPaths.has(change.path)) }, details)).filter(manifest => manifest.files.length),
    diffOmissions,
  };
}
export function nativeArtifacts(files) {
  return files.filter(f => f.exists && !f.rolledBack).map(f => ({ id: `pi-file-${createHash('sha256').update(`${f.threadId}\0${f.path}`).digest('hex').slice(0, 24)}`,
    conversationId: f.threadId, requestId: f.turnId, type: 'file', kind: 'media', uri: f.path, filePath: f.path,
    title: f.name, mimeType: f.mimeType, size: f.size, createdAt: timestamp(f.createdAt), updatedAt: timestamp(f.updatedAt),
    externalChangeDetected: f.currentChanged === true }));
}
export function nativeFileTree(files, cwd) {
  const nodes = [], root = { path: cwd, name: path.basename(cwd), type: 'directory', children: [] };
  const directories = new Map([[cwd, root]]);
  for (const file of files.filter(f => f.exists && !f.rolledBack)) {
    const relative = path.relative(cwd, file.path);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      nodes.push({ path: file.path, name: file.name, type: 'file' }); continue;
    }
    let parent = root, current = cwd;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      current = path.join(current, segment);
      if (!directories.has(current)) { const node = { path: current, name: segment, type: 'directory', children: [] }; directories.set(current, node); parent.children.push(node); }
      parent = directories.get(current);
    }
    parent.children.push({ path: file.path, name: file.name, type: 'file' });
  }
  return [...(root.children.length ? [root] : []), ...nodes];
}
