# Pi 执行器

当前包含两条独立路线：

| 入口 | 登录与执行器 | 说明 |
| --- | --- | --- |
| 原版图标 + 外部客户端组件 | 保留现有私有认证和独立乐享，可切换原生 / Pi，只读实验 | 本文后续内容 |
| 独立 金融buddy.app / DMG | 官方 WorkBuddy 登录，仅 Pi；内置 Pi/Node/rg/fd，默认自动执行，可切回逐次确认 | [安装与验收](../docs/workbuddy-pi-dmg.md)、[构建工具](package-dmg/README.md) |

独立 DMG 当前为 **金融buddy 0.4.13 / WorkBuddy 5.11.1 / Pi 1.5.0**。首页在 Pi 就绪前跳过会话预建，首次发送等待 Pi 接管后创建任务，避免复用原生预建会话。0.4.13 已通过首轮纯文本回归、24 项包内 Pi 测试及镜像校验。干净 Mac 上的官方首次登录和真实模型回复仍待验收。旧原生历史的复数会话上报仍可能触发原生预热。构建步骤见[安装包构建工具](package-dmg/README.md)。

0.4.10 的原生长粘贴、场景输入分类和脱敏诊断继续保留。当时已完成纯文本和富文本完整正文及冷恢复的合成实机验收，范围见[原生输入说明](../docs/workbuddy-pi-native-input.md)。

0.4.9的P0推理/压缩、真实产物与双侧Diff、文件和会话协调回退继续保留，其当时595项源码与24项包内测试及预览/回退/安装实机验收作为基线。快照/Diff预算与限制见[P0说明](../docs/workbuddy-pi-p0.md)。

0.4.4增加的PDF、DOCX、XLSX、PPTX本地解析和扫描PDF OCR继续内置。保留金色图标、原生模型菜单的上下文长度适配、空输出修复、官方认证/模型桥、目录隔离和自动/手动执行设置，旧任务与登录不搬迁。Hy4的300K/600K/960K档位仍通过原生模型菜单进入。

0.4.4当时的五份合成文档通过原生文件选择器发送，Hy4正确读取标记和具体值；完整退出并更新本机后，不重新附加文件也能沿用会话内容续答。397项源码回归、22项包内测试通过；旧27条任务和25个旧会话文件不变。格式、大小限制和数据边界见[文档解析](../docs/workbuddy-pi-documents.md)，最新交付校验见[5.9.2升级说明](../docs/workbuddy-pi-592-upgrade.md)。

此前 **0.3.1 / WorkBuddy 5.9.1 / Pi 1.1.0** 的上下文圆环、旧会话只读查询与重启恢复已实测，无新增聊天请求，见[上下文占用说明](../docs/workbuddy-pi-context-usage.md)。附件、Expert、技能及 MCP 的范围见[原生内容映射](../docs/workbuddy-pi-native-content.md)。原版首页、导航、模型菜单和输入组件继续保留；Pi 在会话服务边界执行新本地对话，CodeBuddy CLI 与 Ollama 直连仍移除。

0.2.8 曾完成原生首页发送、Hy4、单次写入审批、停止、导航与退出恢复，以及 171 项回归。0.3.0 在此基础上完成 274 项回归、2 项内置 Pi 协议及原生内容入口实机验收；原版 1,958 个界面资源指纹保持一致。旧原生本地历史仍只读，未覆盖的原生能力以最新范围说明为准。[交付与验收](../docs/workbuddy-pi-dmg.md)、[原生界面边界](../docs/workbuddy-pi-native-ui.md)、[模型桥](../docs/workbuddy-pi-official-models.md)。

下文的 230 项回归和只读范围描述第一条路线当时的验证，不代表独立 DMG 的全部能力或验收结果。

## 原版外部执行器实验

在原版 WorkBuddy 5.9.1 / macOS Apple Silicon 中增加“原生 / Pi 外部”会话来源。用户继续点击原版图标；不改安装包、不新增启动 App、不替换系统的 `codebuddy`，也不将模型请求交给认证网关。本轮使用本机 Pi 1.1.0、Ollama 0.40.9 和已有 `qwen3.8:27b`。

## 实现

现有启动监听器按原流程完成原版图标交接，临时 Node Inspector 在入口执行前安装 Pi 宿主钩子，之后关闭。宿主只对已核对 ASAR 的主 renderer 挂接 `webContents.debugger`，不开放调试 TCP 端口。随机绑定名及主 frame/context 检查将原生会话请求交给内存中的 Host；保留原生 conversations 对象，其余请求透传。

Pi 由本机已安装的可执行文件启动，使用严格 LF JSONL RPC。适配层映射逐块文本、工具、取消和终态；只有 `agent_settled` 或 `handled` 才按实际情况完成一轮，不能把 prompt ACK 或 `agent_end` 当最终完成。5.9.1 的 `requestUpdate` 第四参数必须带 typed patches，完整 assistant block 按连续 index 更新。来源和范围见[原生界面合同](docs/renderer-contract.md)。

每个外部线程有独立 Pi session 文件，Host 可见历史和 UI 选择另外持久化，数据目录由 Host 锁单实例占用。重启不重放旧 prompt。正常退出时关闭 Pi stdin，有限等待后仅使用 SIGTERM，不使用 SIGKILL。关闭异常时保留诊断状态，不把旧进程当新会话继续复用。

## 配置

需要包含 Pi 组件且清单校验通过的当前开发版客户端。已发布的旧客户端包不具备此功能；本轮只更新了本机用户级组件，没有发布新 Release。

在安装后的 `~/Library/Application Support/EnterpriseWorkbenchClient/state/workbuddy-launcher.json` 合并以下字段，保留现有认证、乐享和名称配置：

```json
{
  "piHarness": {
    "enabled": true,
    "configFile": "/absolute/path/to/private/pi-config.json"
  }
}
```

`pi-config.json` 为普通 JSON 文件，放在安装包之外：

```json
{
  "command": "/absolute/path/to/pi",
  "cwd": "/absolute/path/to/workspace",
  "stateDir": "/absolute/path/to/private/pi-state",
  "agentDir": "/absolute/path/to/private/pi-agent",
  "provider": "ollama",
  "model": "qwen3.8:27b",
  "modelName": "Pi · Qwen3.8 27B (Ollama)"
}
```

`stateDir` 和 `agentDir` 不能使用符号链接；私有目录 0700，状态文件 0600。`agentDir` 作为隔离的 `PI_CODING_AGENT_DIR`，不会写入用户既有 `~/.pi`。模型配置另放在该目录的 `models.json`，它不自动读取 WorkBuddy 的模型定义。例如本轮使用的回环测试配置：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{
        "id": "qwen3.8:27b",
        "reasoning": true,
        "thinkingLevelMap": { "off": "none" },
        "input": ["text"],
        "contextWindow": 32768,
        "maxTokens": 2048,
        "compat": {
          "supportsStore": false,
          "supportsDeveloperRole": false,
          "supportsReasoningEffort": true,
          "maxTokensField": "max_tokens"
        }
      }]
    }
  }
}
```

`ollama` 是本地无认证测试用的占位 key。真实模型凭据保留在私有模型配置/凭据管理中，不放进启动配置、源码或交付包。这里的 `contextWindow` 是 Pi 的上下文预算，不改变 Ollama 模型实际 `num_ctx`；本轮保留了已有模型的 65536 默认值，没有重新量化或改模型参数。

修改后正常退出 WorkBuddy，再点击原版图标。进入 Pi 外部模式后，原生输入框只发送文本；主账号和独立乐享登录仍由原有路径处理。运行诊断在 `stateDir/bridge-status.json`，只含状态、PID 和适配结果，不记录模型 Key 或完整 RPC。

## 本轮验收

- 原版 5.9.1 的 Pi 会话使用真实 Pi RPC 进程，直连本机 Ollama。
- Pi 的 `read` 工具读取专用测试文件，原生界面显示正确校验码和读取记录。
- 生成结束前，原生会话持续显示增量正文；点击“停止”显示“用户已取消”，随后同一会话可以继续回答。
- 可在“原生 / Pi 外部”之间切换，原有会话保留。
- 完整退出后确认 WorkBuddy/Pi 进程已结束，再从 Finder 双击原版图标；外部线程、三轮历史和取消状态自动恢复，主账号保持登录。
- 重启后继续询问先前文件的校验码，Pi 在不调用工具的情况下正确回答，验证了真实 Pi session 上下文恢复，而不只是在界面缓存中显示历史；乐享独立账号的原生目录仍正常。
- 从原生乐享页直接点击侧栏 Pi 会话，选择状态正确持久化；正常退出后仍保留 Pi 选择，下一次原版图标启动自动恢复，无需手动切换。
- 完整回归 `node --test pi-harness/test/*.test.mjs auth-gateway/test/*.test.mjs`：230/230 通过。

本机截图及运行记录在忽略目录 `evidence/pi-harness-20261024/`，其中包含会话正文和配置，不进入 Git 或客户端包。最终确认 ASAR、主程序、内置产品配置及原 WorkBuddy 模型文件哈希未变；主会话与乐享绑定仍各为原来同一个，34 个 payload 文件校验通过，临时 Inspector 端口关闭。Pi 的原全局配置未被复制或写入，实验进程使用单独 agentDir。

## 范围与停用

这是一个单模型、文本输入、只读工具实验。固定启用 Pi 的 `read`，关闭 MCP、扩展、skills、项目上下文、提示模板及联网启动；这不构成操作系统级文件沙箱。暂未接入写入、Bash、审批交互、附件/图片、工作台技能、乐享材料到 Pi、原生检查点/回退或多人并发。不会将缺失能力伪装成可用。模型回答质量与性能另行评估。

WorkBuddy 与乐享登录界面可继续使用，但其授权和资源不会自动授予 Pi。Pi 的模型认证独立于 WorkBuddy；未来接入知识库和工具须显式映射。

设置 `"piHarness":{"enabled":false}`，完整退出后点击原版图标即可回到原生执行。Pi 状态、session 与隔离配置保留；不要删除模型或认证数据。仅在界面切换“原生”可以立即继续原生会话，组件本身仍在当前进程中。

本轮未安装/升级 Pi、未改全局 Pi 配置、未改远端服务、未发布安装包，未验证整机重启和客户隔离网。Pi 或 WorkBuddy 升级后需重验合同；WorkBuddy ASAR 不匹配时拒绝启用 Pi 钩子。

本机实验的配置、状态和测试工作目录位于上述 `evidence/`，移动或删除工作区前需先停用 Pi，或在正常退出后迁移到用户私有目录并重新验证会话恢复；当前不作为脱离开发工作区的客户交付包。
