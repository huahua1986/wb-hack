#!/bin/bash
set -euo pipefail
umask 077

release_input=${1:?Path to the staged pi-harness directory is required}
token_digest=${2:?Application token SHA-256 is required}
[[ $token_digest =~ ^[a-f0-9]{64}$ ]]
node_bin=/opt/workbuddy-runtime/node-v24.21.0-linux-x64/bin/node
service=workbuddy-pi-https
prefix=/opt/workbuddy-pi-https
data_dir=/var/lib/workbuddy-pi-https
profile=$data_dir/agent
config=/etc/workbuddy-pi-https.json
unit=/etc/systemd/system/workbuddy-pi-https.service
vhost=/etc/nginx/conf.d/workbuddy-auth.conf
route=/etc/nginx/workbuddy-pi-https-location.conf

test "$(id -u)" = 0
test -x "$node_bin"
test -x /usr/local/bin/pi
test -f "$vhost"
test ! -L "$vhost"
test ! -e "$prefix"
test ! -e "$config"
test ! -e "$unit"
test ! -e "$route"
test ! -e "$data_dir"
! getent passwd "$service" >/dev/null
"$node_bin" --check "$release_input/src/pi-http-server.mjs"
"$node_bin" --check "$release_input/scripts/remote-pi-rpc.cjs"

# Dedicated service identity has no interactive shell or SSH credentials.
useradd --system --user-group --no-create-home --home-dir "$data_dir" --shell /sbin/nologin "$service"
install -d -m 0755 "$prefix/src" "$prefix/scripts"
install -m 0644 "$release_input/src/pi-http-server.mjs" "$prefix/src/"
install -m 0644 "$release_input/scripts/remote-pi-rpc.cjs" "$prefix/scripts/"
install -d -m 0700 -o "$service" -g "$service" "$data_dir" "$profile"

"$node_bin" - "$profile" "$config" "$token_digest" "$data_dir" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [profile, config, digest, dataDir] = process.argv.slice(2);
const previous = '/root/.pi/agent/';
const provider = JSON.parse(fs.readFileSync(previous + 'models.json')).providers?.tokenlink;
const credential = JSON.parse(fs.readFileSync(previous + 'auth.json')).tokenlink;
if (provider?.baseUrl !== 'https://tokenlink.woa.com/openapi/v1' ||
    !provider.models?.some(model => model.id === 'hy4') ||
    credential?.type !== 'api_key' || typeof credential.key !== 'string') {
  throw Error('Expected the configured TokenLink provider and hy4 credential');
}
const entries = {
  'models.json': { providers: { tokenlink: provider } },
  'auth.json': { tokenlink: credential },
  'settings.json': { defaultProvider: 'tokenlink', defaultModel: 'hy4', defaultThinkingLevel: 'off' },
};
for (const [name, value] of Object.entries(entries)) {
  fs.writeFileSync(path.join(profile, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
fs.writeFileSync(config, JSON.stringify({
  host: '127.0.0.1', port: 8793, dataDir, agentDir: profile,
  tokens: [{ owner: 'local-workbuddy', sha256: digest }],
}, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
JS
chown "$service:$service" "$profile/"*.json "$config"

cat >"$unit" <<'UNIT'
[Unit]
Description=WorkBuddy remote Pi HTTPS backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=workbuddy-pi-https
Group=workbuddy-pi-https
WorkingDirectory=/var/lib/workbuddy-pi-https
ExecStart=/opt/workbuddy-runtime/node-v24.21.0-linux-x64/bin/node /opt/workbuddy-pi-https/src/pi-http-server.mjs /etc/workbuddy-pi-https.json
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/workbuddy-pi-https
Restart=on-failure
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit"
systemctl daemon-reload
systemctl start "$service"
for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8793/v1/pi/healthz >/dev/null; then break; fi
  sleep 0.3
done
curl -fsS --max-time 2 http://127.0.0.1:8793/v1/pi/healthz >/dev/null

cat >"$route" <<'NGINX'
location ^~ /v1/pi/ {
    proxy_pass http://127.0.0.1:8793;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host 21.130.240.28;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 45s;
    client_max_body_size 25m;
}
NGINX
chmod 0644 "$route"
backup=$(mktemp /etc/nginx/.workbuddy-auth-before-pi.XXXXXX)
cp -p -- "$vhost" "$backup"
export WB_PI_VHOST="$vhost"
"$node_bin" - <<'JS'
const fs = require('node:fs');
const filename = process.env.WB_PI_VHOST;
const source = fs.readFileSync(filename, 'utf8');
const anchor = '    location / {';
if (!source.includes('listen 443 ssl;') || source.split(anchor).length !== 2 ||
    source.includes('/etc/nginx/workbuddy-pi-https-location.conf')) throw Error('Unrecognized WorkBuddy TLS vhost');
const temporary = filename + '.pi-tmp';
fs.writeFileSync(temporary, source.replace(anchor, '    include /etc/nginx/workbuddy-pi-https-location.conf;\n' + anchor),
  { mode: fs.statSync(filename).mode & 0o777, flag: 'wx' });
fs.renameSync(temporary, filename);
JS
if ! nginx -t || ! systemctl reload nginx; then
  cp -p -- "$backup" "$vhost"
  nginx -t && systemctl reload nginx
  exit 1
fi
systemctl enable "$service"
printf 'Pi HTTPS service active. Nginx rollback copy %s\n' "$backup"
