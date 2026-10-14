select_ollama_node() {
  local override candidate major
  override="$(/usr/bin/plutil -extract nodeExecutable raw -o - workbuddy-launcher.json 2>/dev/null)"
  for candidate in "$override" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    major="$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)"
    if [[ "$major" == <-> ]] && (( major >= 24 )); then
      OLLAMA_TUNE_NODE_BIN="$candidate"
      return 0
    fi
  done
  print -u2 -- '需要 Node.js 24 或更新版本。可在 workbuddy-launcher.json 配置 nodeExecutable。'
  return 1
}
