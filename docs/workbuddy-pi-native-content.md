# 金融buddy 0.3.0：原生内容到 Pi 的映射

后续版本补充：0.4.11增加已安装单agent专家包解析与完整身份传递，见[专家加载修复](workbuddy-pi-expert-loading.md)。0.4.4已增加PDF/DOCX/XLSX/PPTX本地解析和扫描PDF OCR，当前能力、限制和验证状态见[文档解析说明](workbuddy-pi-documents.md)。以下为0.3.0当时的映射与验收记录，PDF/Office未覆盖等描述不再代表最新候选。

本次基于 WorkBuddy 5.9.1 和 Pi 1.1.0，延续 0.2.8 的原生界面模式。只修改独立候选副本的会话适配与 daemon 桥，原版 `/Applications/WorkBuddy.app`、首页、导航、模型菜单和输入组件保持原样。继续使用官方登录和官方模型桥，不恢复 CodeBuddy CLI，不启用已停用的本地自动接管服务。

## 已实现的路径

| 原生入口 | Pi 实际收到的内容 | 边界 |
| --- | --- | --- |
| 附件 / @文件 | 主进程读取所选 UTF-8 文本；本地 PNG/JPEG/GIF/WebP 转 Pi image 内容 | 只读明确选择的文件，检查路径、签名、MIME、大小和读时变化，不获取远端 URL |
| 普通选区 / 腾讯文档选区 | 只传选中的文字 | 不读取整个源文件，不用预览图片代替选区 |
| Expert | 实际本地化 `prompt` 加到本轮 system prompt | 名称和 ID 不能代替指令；无 prompt 的插件和团队编排明确拒绝 |
| @技能 | 原生已安装目录解析身份，再读取明确的 `SKILL.md`；包含资源目录 | 不自动运行脚本、不加载技能中的 JS 扩展和项目 hooks；脚本执行仍需工具审批 |
| 原生 MCP | managed connector 按会话选择；自定义 user MCP 沿用原生设置页手动新增并启用/信任的全局语义；只注册 ready 工具和完整 schema | 远程 HTTP/SSE 复用 daemon 会话；普通 stdio 在单次审批后启动独立 MCP 子进程，执行一次并关闭 |

Expert 与连接器选择保存在原有私有线程状态，清除后下一轮不再注入。每次发送重新解析当前技能；技能属于本轮显式 @内容。Pi 的会话文件保存实际模型上下文，重启沿用同一 session。技能正文或图片不会塞进 renderer 的 64 KiB binding；它只发送路径、选择和有限元数据。

## 调用和授权原理

原生 `conversations/config/input` facade → Host 规范化输入 → 私有 per-thread context 文件 → 明确加载的受控 Pi 扩展。`before_agent_start` 每轮读取当前 Expert、技能指令与 MCP 名称映射，不把上轮已清除的指令反复追加。

MCP 工具用完整原生 server ID 的稳定哈希名称防止不同服务器和来源同名冲突。启动 Pi 时在 `--tools` 精确列出已选工具，不使用 `*`。原生 UI 的 `setConnectors` 对象按 `name` 配置 ID 解析，保留显示名；调用继续使用真实 server ID 和 raw tool name。

模型发起工具调用后先走原生单次审批。Host 校验并消费绑定 `threadId/turnId/toolCallId/工具名/参数` 的一次授权，再通过已有本机模型桥的短期 ticket 调用 daemon；桥和 daemon 再校验当前官方账号、MCP manager UID、原生生命周期 fence、配置指纹、连接状态、信任与工具策略。官方凭据、连接器 headers/env 和启动配置不会进入 Pi 的模型上下文。

设置页信任并启用 MCP 后，原生程序仍会执行工具探测；stdio 探测可能启动一次服务进程以读取工具目录。业务 `tools/call` 则继续逐次审批，不能把“探测已连接”当成已允许工具调用。

HTTP/SSE 直接使用已连接 session 的单次调用，避开 controller 的 401 自动重试。普通 stdio 使用原生解析的 command/args/env/cwd；`shell:false`，命令字符串不自行拆分。`node` 使用本包固定 Pi Node，原生 MCP 探测的 command/PATH 也同步改用该运行时，避免旧 CLI 删除后误启动 Electron。仅启动被审批的 MCP 服务，不恢复 agent CLI。

停止会中断准备阶段和 Pi 请求；stdio 会关闭本次持有的子进程。远程 MCP 没有可证明的逐次远端撤销合同，已发出的副作用可能完成；取消只撤回等待并丢弃迟到结果。超时、断线、账号变化均不自动重放工具调用。

## 明确未覆盖

- PDF/Office 解析、无本地文件路径的粘贴图片、远端网盘/乐享文件附件；需先转为支持的本地文件。
- Expert 的插件、团队、多代理编排和自动加载可执行扩展。
- Buddy/plugin/first-party 来源的 MCP、需要 `localRoute` 探测身份的 stdio、CLI 型连接器。它们需要各自的原生授权与 session 合同，不能当作通用 connector 工具。
- 普通 stdio 每次审批后使用独立短进程，尚未验证依赖跨调用常驻内存状态的服务。
- 原生 OS 沙箱、完全访问、分享、检查点、回退和云执行。现有 Pi 工作区与逐次审批不等于 OS 沙箱。

默认最多 16 个附件、文件及图片总计 4 MiB，单文本文件 512 KiB；Expert 24 KiB、单技能 128 KiB、最多 8 个技能且上下文总计 512 KiB。过大、未完成、符号链接、乱码和文件变化都会明确报错，不静默丢附件。

## 验证和交付状态

源码回归包含当前 5.9.1 的原样消费者切片及 SHA-256，覆盖原生附件构造器、Expert 本地化/回退、技能身份和文件路径、connector 选择对象、MCP 上下文与工具策略、UID 切换的中间窗口、配置变化、单次审批防重放、取消及重启恢复。

真实 Pi 离线协议测试已经完成：本机假模型桥观察到 Expert/技能指令与真实生成的 PNG，模型工具调用触发真实审批，经 MCP 结果返回后续轮完成。测试使用私有临时 HOME，没有读取账号或调用外部模型。普通 stdio 另用真实 Node Mock 子进程验证初始化、调用、取消、超时和进程清理。

冻结候选的预检结果：276 项回归中 274 通过，2 项 opt-in 使用同一候选内置 Node/Pi 和扩展另跑，2/2 通过。30 项构建源码哈希、26 个打包 Harness 文件一致；原版 1,958 个 renderer 文件指纹仍为 `781aea7843d79f21dbed84deb1518a23d0541483186b16e842994df439645740`。原版与候选均通过完整系统访问环境的 strict/deep 签名校验；受限环境曾误报，未修改或修复原版。预检及同一候选的 GUI 结果分别记录在交付目录的 `预检记录.json/md` 和 `验收记录.json/md`。

同一冻结候选已完成 GUI 验收：原生文本附件返回文件内标记、PNG 正确识别绿色、原生召唤测试专家和“去试试”测试技能均返回各自正文内标记。HTTP/SSE 路径中的 HTTP Mock 和普通 stdio Mock 经原生保存/信任/连接后，实际 Hy4 工具调用、单次审批、结果回传与续答通过；stdio 审批前 `tools/call=0`，允许后只执行一次并清理子进程。

真实停止使活动模型请求从 1 变为 0，取消与上游中断各增 1，错误为 0。完整退出清理主进程、Pi、锁和 locator；重启无需重新登录，Hy4、Expert、会话恢复，继续对话和 MCP 调用通过且仍要求单次审批。原生清除 Expert 后，后端选择为空，当前指令中不再含其正文。验收 Mock 已停用，HTTP 服务已停止。

stdio 验收有一项环境条件：初次位于 Documents 的 Mock 初始化超时；将脚本副本置于私有临时目录并重新信任后，原生探测和实际调用通过。当前证据不能单独确定 TCC 根因，候选代码未因此改变。客户现场需验证 MCP 程序路径与权限；Mock 验收不代表所有真实业务服务已验收。

交付目录为 `dist/金融buddy-5.9.1-test-0.3.0/`，DMG 为 `金融buddy-5.9.1-0.3.0-arm64-internal.dmg`。构建、实机验收与镜像核对分别见 manifest、验收记录和镜像校验文件。仍为 ad hoc 签名、未公证的内部包。

运行数据仍在 `~/Library/Application Support/WorkBuddy-Pi-5.9.1/`，不进入应用或镜像。`threads.json` 只保存附件元数据，但 Pi session 可能含实际输入、图片、工具结果；请按会话敏感数据管理。回退可退出新候选后启动旧版独立应用，沿用原登录和会话；不自动导入原版账号。

相关代码：[输入准备](../pi-harness/src/turn-input.mjs)、[Expert/技能](../pi-harness/src/native-context.mjs)、[受控扩展](../pi-harness/src/native-feature-extension.mjs)、[MCP 原生服务](../pi-harness/src/native-mcp-service.cjs)、[stdio](../pi-harness/src/native-stdio.cjs)。
