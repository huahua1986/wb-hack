#!/usr/bin/env bash
set -euo pipefail
umask 077
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
SOURCE_DIR="$(dirname -- "$SCRIPT_DIR")"
NODE="$(command -v node || true)"
PREFIX=/opt/workbuddy-auth
DATA_DIR=/var/lib/workbuddy-auth
CONFIG_DIR=/etc/workbuddy-auth
SERVICE_USER=workbuddy-auth
PORT=8787
ORIGIN=
TLS_CERT=
TLS_KEY=
RENDER_ONLY=
while [ "$#" -gt 0 ]; do
    [ "$#" -ge 2 ] || { echo "Every option requires a value" >&2; exit 1; }
    case "$1" in
        --origin) ORIGIN="$2" ;; --tls-cert) TLS_CERT="$2" ;; --tls-key) TLS_KEY="$2" ;;
        --node) NODE="$2" ;; --prefix) PREFIX="$2" ;; --data-dir) DATA_DIR="$2" ;;
        --config-dir) CONFIG_DIR="$2" ;; --service-user) SERVICE_USER="$2" ;;
        --port) PORT="$2" ;; --render-only) RENDER_ONLY="$2" ;;
        *) echo "Unknown installation option" >&2; exit 1 ;;
    esac
    shift 2
done
[ -n "$NODE" ] && [ -x "$NODE" ] || { echo "Install Node.js 24+ and pass --node with a system binary" >&2; exit 1; }
"$NODE" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' || { echo "Node.js 24+ is required" >&2; exit 1; }
STAGE="$(mktemp -d)"
cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT
OUTPUT="$STAGE/rendered"
if [ -n "$RENDER_ONLY" ]; then OUTPUT="$RENDER_ONLY"; fi
"$NODE" "$SCRIPT_DIR/render.mjs" --origin "$ORIGIN" --tls-cert "$TLS_CERT" --tls-key "$TLS_KEY" --node "$NODE" --prefix "$PREFIX" --data-dir "$DATA_DIR" --config-dir "$CONFIG_DIR" --service-user "$SERVICE_USER" --port "$PORT" --output "$OUTPUT"
if [ -n "$RENDER_ONLY" ]; then exit 0; fi
[ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || { echo "Installation requires root on a Linux systemd host; use --render-only to inspect elsewhere" >&2; exit 1; }
for command in nginx systemctl useradd runuser flock install; do command -v "$command" >/dev/null || { echo "Missing deployment prerequisite: $command" >&2; exit 1; }; done
systemctl show-environment >/dev/null
systemctl is-active --quiet nginx || { echo "Start the installed Nginx service before deploying authentication" >&2; exit 1; }
[ -r "$TLS_CERT" ] && [ -r "$TLS_KEY" ] || { echo "Provide existing TLS certificate/key files" >&2; exit 1; }
exec 9>/run/lock/workbuddy-auth-deploy.lock
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }
RELEASE_ID="$("$NODE" "$SCRIPT_DIR/verify-package.mjs" --id)"
if [ -e "$PREFIX" ] && [ -n "$(ls -A "$PREFIX")" ]; then
    [ -f "$PREFIX/deployment.json" ] || { echo "Refusing an unmanaged application directory" >&2; exit 1; }
    "$NODE" -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(p.kind!=="workbuddy-auth-deployment"||p.prefix!==process.argv[2]||p.dataDir!==process.argv[3]||p.configDir!==process.argv[4]||p.user!==process.argv[5])process.exit(1)' "$PREFIX/deployment.json" "$PREFIX" "$DATA_DIR" "$CONFIG_DIR" "$SERVICE_USER"
elif [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR")" ]; then
    echo "Refusing to adopt a populated data directory automatically" >&2; exit 1
fi
for directory in "$PREFIX" "$DATA_DIR" "$CONFIG_DIR"; do [ ! -L "$directory" ] || { echo "Deployment directories must not be symlinks" >&2; exit 1; }; done
UNIT=/etc/systemd/system/workbuddy-auth.service
NGINX_CONF=/etc/nginx/conf.d/workbuddy-auth.conf
WRAPPER=/usr/local/bin/workbuddy-auth
for target in "$UNIT" "$NGINX_CONF" "$WRAPPER"; do
    if [ -e "$target" ]; then
        [ ! -L "$target" ] && grep -q '^# Managed by workbuddy-auth deployment' "$target" || { echo "Refusing to replace unmanaged deployment file: $target" >&2; exit 1; }
    fi
done
if [ -f "$UNIT" ]; then
    grep -Fxq "WorkingDirectory=$PREFIX/current" "$UNIT" && grep -Fxq "EnvironmentFile=$CONFIG_DIR/gateway.env" "$UNIT" || { echo "Existing authentication service belongs to a different deployment" >&2; exit 1; }
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then useradd --system --user-group --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"; fi
[ "$(id -u "$SERVICE_USER")" -ne 0 ] && [ "$(id -gn "$SERVICE_USER")" = "$SERVICE_USER" ] || { echo "Service account/group do not match" >&2; exit 1; }
install -d -m 0755 "$PREFIX" "$PREFIX/releases"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA_DIR" "$DATA_DIR-backups"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONFIG_DIR"
if [ -e "$PREFIX/current" ]; then
    [ -L "$PREFIX/current" ] || { echo "current must be a managed symlink" >&2; exit 1; }
    case "$(readlink -f "$PREFIX/current")" in "$PREFIX"/releases/*) ;; *) echo "Unmanaged current symlink" >&2; exit 1 ;; esac
fi
PREVIOUS=
if [ -L "$PREFIX/current" ]; then PREVIOUS="$(readlink -f "$PREFIX/current")"; fi
WAS_ACTIVE=0
if systemctl is-active --quiet workbuddy-auth; then WAS_ACTIVE=1; fi
recover_before_switch() {
    result=$?
    if [ "$result" -ne 0 ] && [ "$WAS_ACTIVE" -eq 1 ]; then systemctl start workbuddy-auth || true; fi
    cleanup
    exit "$result"
}
trap recover_before_switch EXIT
if [ -n "$PREVIOUS" ]; then
    systemctl stop workbuddy-auth
    runuser -u "$SERVICE_USER" -- env -i PATH=/usr/bin:/bin "$NODE" --env-file="$CONFIG_DIR/gateway.env" "$PREVIOUS/scripts/backup.mjs"
fi
RELEASE="$PREFIX/releases/$RELEASE_ID"
if [ -d "$RELEASE" ]; then "$NODE" "$RELEASE/deploy/verify-package.mjs" >/dev/null
else cp -R "$SOURCE_DIR" "$RELEASE"; fi
chown -R root:root "$RELEASE"
find "$RELEASE" -type d -exec chmod 0755 {} +
find "$RELEASE" -type f -exec chmod 0644 {} +
find "$RELEASE" -type f -name '*.sh' -exec chmod 0755 {} +
mkdir "$STAGE/saved"
INDEX=0
for target in "$UNIT" "$NGINX_CONF" "$WRAPPER" "$PREFIX/deployment.json"; do
    INDEX=$((INDEX+1)); if [ -e "$target" ]; then cp -p "$target" "$STAGE/saved/$INDEX"; fi
done
rollback_failure() {
    result=$?
    if [ "$result" -ne 0 ]; then
        systemctl stop workbuddy-auth || true
        if [ ! -f "$STAGE/saved/1" ]; then systemctl disable workbuddy-auth || true; fi
        if [ -n "$PREVIOUS" ]; then ln -s "$PREVIOUS" "$PREFIX/recover.$$"; mv -Tf "$PREFIX/recover.$$" "$PREFIX/current"; else rm -f "$PREFIX/current"; fi
        INDEX=0
        for target in "$UNIT" "$NGINX_CONF" "$WRAPPER" "$PREFIX/deployment.json"; do
            INDEX=$((INDEX+1))
            if [ -f "$STAGE/saved/$INDEX" ]; then cp -p "$STAGE/saved/$INDEX" "$target"
            elif [ "$target" != "$PREFIX/deployment.json" ]; then rm -f "$target"
            fi
        done
        systemctl daemon-reload || true
        if [ "$WAS_ACTIVE" -eq 1 ]; then systemctl start workbuddy-auth || true; fi
        nginx -t && systemctl reload nginx || true
        echo "Deployment failed; previous code/config restored. Data and failed release were retained." >&2
    fi
    cleanup
    exit "$result"
}
trap rollback_failure EXIT
if [ ! -e "$CONFIG_DIR/gateway.env" ]; then install -o root -g "$SERVICE_USER" -m 0640 "$OUTPUT/gateway.env" "$CONFIG_DIR/gateway.env"; fi
install -m 0644 "$OUTPUT/workbuddy-auth.service" "$UNIT"
install -m 0644 "$OUTPUT/workbuddy-auth.conf" "$NGINX_CONF"
install -m 0755 "$OUTPUT/workbuddy-auth" "$WRAPPER"
install -m 0644 "$OUTPUT/deployment.json" "$PREFIX/deployment.json"
ln -s "$RELEASE" "$PREFIX/next.$$"
mv -Tf "$PREFIX/next.$$" "$PREFIX/current"
nginx -t
systemctl daemon-reload
systemctl enable workbuddy-auth
systemctl start workbuddy-auth
READY=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if systemctl is-active --quiet workbuddy-auth && "$NODE" --env-file="$CONFIG_DIR/gateway.env" "$RELEASE/scripts/health.mjs"; then READY=1; break; fi
done
[ "$READY" -eq 1 ] || { echo "Backend readiness check failed" >&2; exit 1; }
systemctl reload nginx
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$RELEASE" ]; then ln -s "$PREVIOUS" "$PREFIX/previous.next.$$"; mv -Tf "$PREFIX/previous.next.$$" "$PREFIX/previous"; fi
trap cleanup EXIT
echo "Installed $RELEASE_ID at $ORIGIN"
echo "Create an account: sudo workbuddy-auth user add <username> --display-name <name>"
