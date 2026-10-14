#!/bin/zsh -f

SCRIPT_DIR="${0:A:h}"
CONFIG_FILE="$SCRIPT_DIR/workbuddy-launcher.json"

fail() {
  print -u2 -- "启动失败：$1"
  if [[ -t 0 ]]; then
    print -- "按回车关闭此窗口。"
    read -r
  fi
  exit 1
}

[[ -f "$CONFIG_FILE" ]] || fail "缺少旁边的 workbuddy-launcher.json 配置文件。"
[[ -f "$SCRIPT_DIR/auth-gateway/scripts/double-click-workbuddy.mjs" ]] || fail "缺少启动器程序，请保留同目录的 auth-gateway 文件夹。"

# Parse data rather than sourcing configuration as shell code.
NODE_OVERRIDE="$(/usr/bin/plutil -extract nodeExecutable raw -o - "$CONFIG_FILE" 2>/dev/null)"
NODE_BIN=""
if [[ -n "$NODE_OVERRIDE" ]]; then
  [[ -x "$NODE_OVERRIDE" ]] || fail "配置中的 nodeExecutable 不是可执行文件。"
  NODE_BIN="$NODE_OVERRIDE"
else
  for candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    major="$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)"
    if [[ "$major" == <-> ]] && (( major >= 24 )); then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
[[ -n "$NODE_BIN" ]] || fail "未找到 Node.js 24 或更新版本。安装后重试，或在配置中填写 nodeExecutable 的完整路径。"
major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)"
[[ "$major" == <-> ]] && (( major >= 24 )) || fail "启动器需要 Node.js 24 或更新版本。"

"$NODE_BIN" "$SCRIPT_DIR/auth-gateway/scripts/double-click-workbuddy.mjs" --config "$CONFIG_FILE" "$@"
result=$?
if (( result != 0 )); then
  if [[ -t 0 ]]; then
    print -- "按回车关闭此窗口；修改配置后可再次双击启动。"
    read -r
  fi
  exit "$result"
fi
print -- "启动器已完成，可关闭此终端窗口。"
