import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { validatePublicUrl } from '../src/config.mjs';

const { values } = parseArgs({ options: {
  origin: { type: 'string' }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' }, node: { type: 'string' },
  prefix: { type: 'string', default: '/opt/workbuddy-auth' }, 'data-dir': { type: 'string', default: '/var/lib/workbuddy-auth' },
  'config-dir': { type: 'string', default: '/etc/workbuddy-auth' }, 'service-user': { type: 'string', default: 'workbuddy-auth' },
  port: { type: 'string', default: '8787' }, output: { type: 'string' },
} });
function absolute(value) {
  if (!value || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value.split('/').includes('..') || path.normalize(value) === '/') throw new Error('Deployment paths must be absolute without spaces, traversal or shell characters');
  return path.normalize(value);
}
const origin = validatePublicUrl(values.origin), url = new URL(origin);
if (url.protocol !== 'https:' || url.port || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) || url.hostname === 'localhost') throw new Error('Deployment requires a hostname or IPv4 address with HTTPS on port 443');
const prefix = absolute(values.prefix), dataDir = absolute(values['data-dir']), configDir = absolute(values['config-dir']);
const node = absolute(values.node), cert = absolute(values['tls-cert']), key = absolute(values['tls-key']);
if (/^\/(?:home|root|Users)\//.test(node)) throw new Error('Choose a system Node binary outside protected home directories');
const user = values['service-user'];
if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(user) || user === 'root') throw new Error('Use a dedicated unprivileged service account');
for (const a of [prefix, dataDir, configDir]) for (const b of [prefix, dataDir, configDir]) if (a !== b && a.startsWith(b + '/')) throw new Error('Application, data and config directories must be separate');
if (new Set([prefix, dataDir, configDir]).size !== 3) throw new Error('Deployment directories must differ');
let port = Number(values.port);
const envFile = path.join(configDir, 'gateway.env');
if (fs.existsSync(envFile)) {
  const old = parseEnv(fs.readFileSync(envFile, 'utf8'));
  if (old.GATEWAY_PUBLIC_URL !== origin || old.GATEWAY_DATA_DIR !== dataDir || old.GATEWAY_HOST !== '127.0.0.1') throw new Error('Existing gateway.env differs from requested deployment; edit/migrate it explicitly first');
  port = Number(old.GATEWAY_PORT);
}
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Backend port must be 1024-65535');
const backupDir = dataDir + '-backups';
const lines = items => items.join('\n') + '\n';
const env = lines(['GATEWAY_HOST=127.0.0.1', 'GATEWAY_PORT=' + port, 'GATEWAY_PUBLIC_URL=' + origin, 'GATEWAY_DATA_DIR=' + dataDir,
  'GATEWAY_TRUSTED_PROXY_IPS=127.0.0.1,::1', 'GATEWAY_ACCESS_TTL_SECONDS=3600', 'GATEWAY_REFRESH_TTL_SECONDS=1209600', 'GATEWAY_AUDIT_RETENTION_DAYS=90']);
const unit = lines(['# Managed by workbuddy-auth deployment', '[Unit]', 'Description=WorkBuddy local account authentication', 'After=network-online.target', 'Wants=network-online.target', '',
  '[Service]', 'Type=exec', 'User=' + user, 'Group=' + user, 'WorkingDirectory=' + prefix + '/current', 'EnvironmentFile=' + envFile,
  'ExecStart=' + node + ' ' + prefix + '/current/src/main.mjs', 'Restart=on-failure', 'RestartSec=3', 'TimeoutStopSec=15', 'UMask=0077',
  'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectSystem=strict', 'ProtectHome=true', 'ReadWritePaths=' + dataDir + ' ' + backupDir,
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6', 'LimitNOFILE=4096', 'MemoryMax=512M', '', '[Install]', 'WantedBy=multi-user.target']);
const nginx = lines(['# Managed by workbuddy-auth deployment', "log_format wb_auth '$remote_addr $request_method $uri $status $request_time $upstream_status';", 'server {',
  '    listen 443 ssl;', '    server_name ' + url.hostname + ';', '    ssl_certificate ' + cert + ';', '    ssl_certificate_key ' + key + ';',
  '    ssl_protocols TLSv1.2 TLSv1.3;', '    client_max_body_size 16k;', '    access_log /var/log/nginx/workbuddy-auth.access.log wb_auth;',
  '    if ($host != ' + url.hostname + ') { return 421; }', '    location / {', '        proxy_pass http://127.0.0.1:' + port + ';',
  '        proxy_set_header Host ' + url.hostname + ';', '        proxy_set_header X-Real-IP $remote_addr;',
  '        proxy_set_header X-Forwarded-For "";', '        proxy_http_version 1.1;', '        proxy_read_timeout 20s;', '    }', '}']);
const wrapper = lines(['#!/usr/bin/env bash', '# Managed by workbuddy-auth deployment', 'set -euo pipefail', 'umask 077', 'NODE=' + node, 'PREFIX=' + prefix, 'ENV_FILE=' + envFile,
  'DATA_DIR=' + dataDir, 'SERVICE_USER=' + user, 'export WORKBUDDY_ADMIN_ACTOR="$SUDO_USER"',]);
const management = wrapper.replace('export WORKBUDDY_ADMIN_ACTOR="$SUDO_USER"', 'export WORKBUDDY_ADMIN_ACTOR="${SUDO_USER:-$(id -un)}"') + lines([
  'COMMAND="${1:-help}"', 'if [ "$#" -gt 0 ]; then shift; fi', 'case "$COMMAND" in',
  '  status) exec systemctl status workbuddy-auth --no-pager ;;',
  '  logs) exec journalctl -u workbuddy-auth --no-pager "$@" ;;',
  '  rollback) exec "$PREFIX/current/deploy/rollback.sh" --prefix "$PREFIX" "$@" ;;',
  '  user|session|audit|catalog|backup|health) SCRIPT="$PREFIX/current/scripts/$COMMAND.mjs" ;;',
  '  restore)',
  '    [ "$(id -u)" -eq 0 ] || { echo "Restore requires sudo" >&2; exit 1; }',
  '    [ "$#" -eq 2 ] && [ "$2" = "--confirm-restore" ] || { echo "Usage: workbuddy-auth restore <backup-directory> --confirm-restore" >&2; exit 1; }',
  '    systemctl stop workbuddy-auth',
  '    trap \'systemctl start workbuddy-auth\' EXIT',
  '    env -i PATH=/usr/bin:/bin WORKBUDDY_ADMIN_ACTOR="$WORKBUDDY_ADMIN_ACTOR" "$NODE" --env-file="$ENV_FILE" "$PREFIX/current/scripts/restore.mjs" "$@"',
  '    chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"',
  '    exit 0 ;;',
  '  *) echo "Usage: workbuddy-auth user|session|audit|catalog|backup|restore|status|logs|rollback ..." >&2; exit 1 ;;',
  'esac',
  'if [ "$(id -u)" -eq 0 ]; then',
  '  exec runuser -u "$SERVICE_USER" -- env -i PATH=/usr/bin:/bin TERM="${TERM:-dumb}" WORKBUDDY_ADMIN_ACTOR="$WORKBUDDY_ADMIN_ACTOR" "$NODE" --env-file="$ENV_FILE" "$SCRIPT" "$@"',
  'fi',
  '[ "$(id -un)" = "$SERVICE_USER" ] || { echo "Use sudo to manage authentication" >&2; exit 1; }',
  'exec env -i PATH=/usr/bin:/bin TERM="${TERM:-dumb}" WORKBUDDY_ADMIN_ACTOR="$WORKBUDDY_ADMIN_ACTOR" "$NODE" --env-file="$ENV_FILE" "$SCRIPT" "$@"',
]);
const output = path.resolve(values.output);
if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Render output must be empty');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const [name, content] of [['gateway.env', env], ['workbuddy-auth.service', unit], ['workbuddy-auth.conf', nginx], ['workbuddy-auth', management]]) fs.writeFileSync(path.join(output, name), content, { mode: name === 'workbuddy-auth' ? 0o755 : 0o600, flag: 'wx' });
fs.writeFileSync(path.join(output, 'deployment.json'), JSON.stringify({ kind: 'workbuddy-auth-deployment', version: 1, origin, prefix, dataDir, backupDir, configDir, node, user, port }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ rendered: output, origin, port }));
