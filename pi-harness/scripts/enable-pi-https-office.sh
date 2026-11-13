#!/bin/bash
set -euo pipefail
umask 077

stage=${1:?Path to the staged pi-harness directory is required}
node_dir=/opt/workbuddy-runtime/node-v24.21.0-linux-x64/bin
export PATH="$node_dir:/usr/local/bin:/usr/bin:/bin"
prefix=/opt/workbuddy-pi-https
config=/etc/workbuddy-pi-https.json
service=workbuddy-pi-https
test "$(id -u)" = 0
test -f "$config"
test ! -L "$config"
test ! -e "$prefix/remote-office"
test ! -e "$prefix/src/pi-http-files.mjs"
test -f "$stage/remote-office/package-lock.json"
test -f "$stage/remote-office/extension.ts"
chmod 0755 "$stage" "$stage/remote-office"
chmod 0644 "$stage/remote-office/"*

# Install locked dependencies without lifecycle scripts or access to model credentials.
build_owner=$(stat -c %U "$stage/remote-office/package-lock.json")
if [ "$build_owner" = root ]; then
  install -d -m 0700 -o nobody -g "$(id -gn nobody)" "$stage/npm-cache"
  chown nobody:"$(id -gn nobody)" "$stage/remote-office"
  /usr/bin/setpriv --reuid "$(id -u nobody)" --regid "$(id -g nobody)" --clear-groups \
    env -i PATH="$PATH" npm_config_cache="$stage/npm-cache" \
    npm ci --prefix "$stage/remote-office" --ignore-scripts --legacy-peer-deps --no-audit --no-fund
else
  exit 1
fi
chown -R root:root "$stage/remote-office"
chmod -R a+rX,go-w "$stage/remote-office"
mv -- "$stage/remote-office" "$prefix/remote-office"
install -m 0644 "$stage/src/pi-http-files.mjs" "$prefix/src/"
node --check "$stage/src/pi-http-server.mjs"
node --check "$stage/scripts/remote-pi-rpc.cjs"

backup=$(mktemp -d /etc/.workbuddy-pi-https-office-backup.XXXXXX)
cp -p -- "$config" "$backup/config.json"
cp -p -- "$prefix/src/pi-http-server.mjs" "$backup/server.mjs"
cp -p -- "$prefix/scripts/remote-pi-rpc.cjs" "$backup/launcher.cjs"
rollback() {
  cp -p -- "$backup/config.json" "$config"
  install -m 0644 "$backup/server.mjs" "$prefix/src/pi-http-server.mjs"
  install -m 0644 "$backup/launcher.cjs" "$prefix/scripts/remote-pi-rpc.cjs"
  systemctl reset-failed "$service"
  systemctl restart "$service"
}
install -m 0644 "$stage/src/pi-http-server.mjs" "$prefix/src/"
install -m 0644 "$stage/scripts/remote-pi-rpc.cjs" "$prefix/scripts/"
node - "$config" "$prefix/remote-office/extension.ts" <<'JS'
const fs = require('node:fs');
const [filename, officeExtension] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(filename));
if (config.officeExtension) throw Error('Office is already configured');
const old = fs.statSync(filename);
const tmp = filename + '.office-tmp';
fs.writeFileSync(tmp, JSON.stringify({...config, officeExtension}, null, 2) + '\n', {mode:0o600,flag:'wx'});
fs.chownSync(tmp, old.uid, old.gid);
fs.renameSync(tmp, filename);
JS
if ! systemctl restart "$service"; then rollback; exit 1; fi
for attempt in {1..30}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8793/v1/pi/healthz >/dev/null 2>&1; then break; fi
  sleep 0.3
done
if ! curl -fsS --max-time 2 http://127.0.0.1:8793/v1/pi/healthz >/dev/null; then rollback; exit 1; fi
printf 'Pi HTTPS Office enabled. Rollback files %s\n' "$backup"
