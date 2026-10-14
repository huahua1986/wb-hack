#!/usr/bin/env bash
set -euo pipefail
umask 077
PREFIX=/opt/workbuddy-auth
RELEASE_ID=
DRY_RUN=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --prefix) [ "$#" -ge 2 ]; PREFIX="$2"; shift 2 ;;
        --release) [ "$#" -ge 2 ]; RELEASE_ID="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) echo "Usage: rollback.sh [--prefix <path>] [--release <id>] [--dry-run]" >&2; exit 1 ;;
    esac
done
NODE="$(command -v node)"
"$NODE" -e 'const p=process.argv[1];if(!/^\/[A-Za-z0-9_./-]+$/.test(p)||p.split("/").includes("..")||p==="/")process.exit(1)' "$PREFIX"
[ -f "$PREFIX/deployment.json" ] && [ -L "$PREFIX/current" ] || { echo "No managed deployment found" >&2; exit 1; }
CONFIG_DIR="$("$NODE" -e 'const p=require(process.argv[1]);if(p.kind!=="workbuddy-auth-deployment")process.exit(1);process.stdout.write(p.configDir)' "$PREFIX/deployment.json")"
NODE="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).node)' "$PREFIX/deployment.json")"
OLD="$(readlink -f "$PREFIX/current")"
if [ -n "$RELEASE_ID" ]; then
    [[ "$RELEASE_ID" =~ ^0\.(2|3)\.[0-9]+-[a-f0-9]{12}$ ]] || { echo "Invalid release id" >&2; exit 1; }
    TARGET="$PREFIX/releases/$RELEASE_ID"
else
    [ -L "$PREFIX/previous" ] || { echo "No previous release; select --release explicitly" >&2; exit 1; }
    TARGET="$(readlink -f "$PREFIX/previous")"
fi
for release in "$OLD" "$TARGET"; do
    case "$release" in "$PREFIX"/releases/*) ;; *) echo "Unmanaged release path" >&2; exit 1 ;; esac
    "$NODE" "$release/deploy/verify-package.mjs" >/dev/null
done
if [ "$DRY_RUN" -eq 1 ]; then echo "Rollback plan: $OLD -> $TARGET (database retained)"; exit 0; fi
[ "$(uname -s)" = Linux ] && [ "$(id -u)" -eq 0 ] || { echo "Rollback requires root on Linux" >&2; exit 1; }
grep -Fxq "WorkingDirectory=$PREFIX/current" /etc/systemd/system/workbuddy-auth.service && grep -Fxq "EnvironmentFile=$CONFIG_DIR/gateway.env" /etc/systemd/system/workbuddy-auth.service || { echo "Service does not belong to this deployment" >&2; exit 1; }
exec 9>/run/lock/workbuddy-auth-deploy.lock
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }
USER_NAME="$("$NODE" -e 'process.stdout.write(require(process.argv[1]).user)' "$PREFIX/deployment.json")"
WAS_ACTIVE=0
if systemctl is-active --quiet workbuddy-auth; then WAS_ACTIVE=1; fi
recover() {
    result=$?
    if [ "$result" -ne 0 ]; then
        systemctl stop workbuddy-auth || true
        ln -s "$OLD" "$PREFIX/recover.$$"; mv -Tf "$PREFIX/recover.$$" "$PREFIX/current"
        if [ "$WAS_ACTIVE" -eq 1 ]; then systemctl start workbuddy-auth || true; fi
        echo "Rollback failed; original release restored" >&2
    fi
    exit "$result"
}
trap recover EXIT
systemctl stop workbuddy-auth
runuser -u "$USER_NAME" -- env -i PATH=/usr/bin:/bin "$NODE" --env-file="$CONFIG_DIR/gateway.env" "$OLD/scripts/backup.mjs"
ln -s "$TARGET" "$PREFIX/next.$$"; mv -Tf "$PREFIX/next.$$" "$PREFIX/current"
systemctl start workbuddy-auth
READY=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if systemctl is-active --quiet workbuddy-auth && "$NODE" --env-file="$CONFIG_DIR/gateway.env" "$TARGET/scripts/health.mjs"; then READY=1; break; fi
done
[ "$READY" -eq 1 ] || exit 1
ln -s "$OLD" "$PREFIX/previous.next.$$"; mv -Tf "$PREFIX/previous.next.$$" "$PREFIX/previous"
trap - EXIT
echo "Rolled back to $TARGET; database retained"
