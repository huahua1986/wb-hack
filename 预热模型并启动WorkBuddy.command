#!/bin/zsh -f
cd "${0:A:h}" || exit 1
source scripts/ollama-local/node.zsh
select_ollama_node || exit 1
"$OLLAMA_TUNE_NODE_BIN" scripts/ollama-local/preflight.mjs || exit 1
print -- '开始为本机模型预热稳定提示词前缀；首次预热需要数分钟。'
OLLAMA_TEST_ORIGIN=http://127.0.0.1:11434 "$OLLAMA_TUNE_NODE_BIN" scripts/ollama-local/prime.mjs "startup-$(date +%Y%m%d-%H%M%S)" qwen3.8:27b || exit 1
exec ./启动WorkBuddy.command
