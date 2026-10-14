#!/bin/zsh -f
cd "${0:A:h}" || exit 1
source scripts/ollama-local/node.zsh
select_ollama_node || exit 1
"$OLLAMA_TUNE_NODE_BIN" scripts/ollama-local/model-tag.mjs rollback || exit 1
"$OLLAMA_TUNE_NODE_BIN" scripts/ollama-local/environment.mjs rollback || exit 1
print -- '原性能环境已恢复。请完整退出 Ollama，再正常启动 Ollama。'
print -- '原 qwen3.8:27b 模型清单已恢复。Q4 测试副本仍保留，不会自动启用。'
