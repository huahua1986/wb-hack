#!/bin/zsh -f
cd "${0:A:h}" || exit 1
source scripts/ollama-local/node.zsh
select_ollama_node || exit 1
"$OLLAMA_TUNE_NODE_BIN" scripts/ollama-local/model-tag.mjs apply || exit 1
"$OLLAMA_TUNE_NODE_BIN" scripts/ollama-local/environment.mjs apply || exit 1
print -- '性能环境已设置。请完整退出 Ollama，再正常启动 Ollama。'
print -- '此脚本不替换模型权重，不修改 WorkBuddy。'
