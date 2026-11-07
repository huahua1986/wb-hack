# WorkBuddy 内置 CLI 与 Pi 能力差距

后续进展：[设置与文件工作流P0实现及验证边界](workbuddy-pi-p0.md)。以下矩阵保留0.4.4调研基线，已补齐项以新版本说明和验收记录为准。

核对日期：2026-10-27。范围为原版 **WorkBuddy 5.9.2 / `@genie/agent-cli` 2.165.0**，以及已交付的 **金融buddy 0.4.4 / Pi 1.4.0**。本报告针对独立 Pi DMG 路线，不把早期外部启动器、私有认证网关或旧版本的能力混算进来。

## 结论

原版 CLI 同时承担模型驱动的执行循环、工具装配与执行、计划和交互、子任务、上下文管理、检查点等工作，并依赖桌面 daemon 注入账号、业务连接器与运行环境。把模型桥接通，只完成了其中的模型访问部分。

当前 Pi 版已经具备可用的基础执行链：官方登录与模型、流式对话、文件/命令工具、日期工作目录、审批/停止、会话恢复、本地附件和文档解析，以及部分 Expert、技能和 MCP。接下来最值得补的是**原生配置的真实生效、文件产物和变更记录、原生业务工具接入、执行中的交互与任务状态**。多 Agent、云记忆和桌面自动化则涉及独立服务与调度设计。

不能给出“已兼容原版多少百分比”：源码里的工具实现、产品配置声明、账号实际暴露目录、现场能成功执行，是不同的统计对象。

## 证据范围

- 原版 ASAR：`/Applications/WorkBuddy.app/Contents/Resources/app.asar`，SHA-256 `0b79c0358c129749bc3355f52bbae13f115577ab37c082a76dfdc54f66fd3f79`；与本仓库已核验源副本一致。
- 内置包：`cli/package.json` 声明 `@genie/agent-cli` **2.165.0**；入口 `cli/bin/codebuddy`；WorkBuddy 精简执行包为 `cli/dist/codebuddy-lite-wb.mjs`，9,880,178字节，SHA-256 `29a2e96949fd85143f85c9fa31ae036657a15c351e847c7944b53a218c850a4d`。
- 当前 Pi 源码的 `src/` 文件哈希与 0.4.4 构建 manifest 一致。已有桌面验证引用[0.4.4 文档解析验收](workbuddy-pi-documents.md)和此前对应版本的记录；本轮没有重新运行全部功能。
- 本轮是静态分析：没有运行原版 CLI、发送模型请求、调用业务 MCP 或读取账号和业务会话。下文“原版实现”表示找到方法与调用链，仍可能受产品、账号、平台和环境开关约束。

## 原版的分工与工具装配

原版由桌面 daemon 建立会话，解析 bundled CLI 路径，通过 ACP 类会话协议调用执行器。原样代码中可见 `session/prompt`、`session/steer`、`session/cancel`、`session/set_model`、`session/rollback`、`checkpoint/read` 和 `delegateToolsChanged` 等控制路径。[E1]

daemon 还将腾讯文档 agent 环境、企业微信 CLI 运行环境、connector token 环境、内置插件环境、项目 MCP 和 Agent Teams 环境提供给原生 backend；其内置工具组装函数另外挂入技能安装/管理、自动化更新及结果回传等工具。[E2]

因此需要分别核对三处：

| 所在位置 | 承担的工作 | 对 Pi 替换的影响 |
| --- | --- | --- |
| CLI 执行器 | agent loop、本地工具、工具注册和启用判定、计划、子 Agent、hooks、上下文与检查点 | 需要 Pi 自带能力、受控扩展及 Host 适配共同承接 |
| 桌面 daemon / 原生界面 | 认证、目录、连接器、浏览器/桌面宿主、会话与文件状态、部分内置业务工具 | 可以复用，但必须建立具体接口和生命周期映射 |
| 云端服务 / 外部 CLI | 官方搜索、云记忆、媒体生成、资料上传、企业微信等业务访问 | 还依赖服务地址、账号权益、认证、外部程序与现场可达性 |

原版工具进入模型之前，经过以下装配链：[E3]

1. `ToolManager.init()` 从 provider 取工具对象，为 `execute` 包装 `executeToolWithHooks` 后加入工具表。
2. Agent 根据默认配置与 session plugin tools 构造集合，合入适用的动态工具，排除权限禁止项；委派工具还要求 provider 真正存在。
3. `createIsEnabledChecker()` 检查工具自身开关、延迟启用、当前会话范围、CLI 参数、权限模式和计划模式。
4. 实际执行还经过 hooks、输入校验、审批、继承限制、文件/网络策略及修改前 checkpoint。

静态计数也反映了这个区别：

| 统计对象 | 本次观察 | 能证明什么 |
| --- | --- | --- |
| `cli/product.json` 的默认 Agent 工具列表 | 41个工具名 | 打包配置声明，不证明全部实现或当前账号启用 |
| cloudhosted / internal / ioa / selfhosted 的默认列表 | 分别39 / 40 / 41 / 52个工具名 | 不同产品配置的声明存在差异，不能混为一个默认目录 |
| 主执行包的工具名构造器赋值 | 68个实现/注册候选 | 找到代码候选；不是运行时启用数量，也不是完整产品功能数 |
| 当前账号实际暴露、成功执行的工具 | 本轮未采集 | 需要对原版运行会话另做受控验证 |

## 能力对照

“已接通”只针对表中明确范围；保留原生页面或插件目录不表示其全部执行能力已迁移。[E4]

| 能力 | 原版 CLI / 原生体系中的实现证据 | 金融buddy 0.4.4 现状 | 需要补齐的部分 |
| --- | --- | --- | --- |
| 模型与认证 | 产品模型目录、官方认证、模型参数与会话配置；部分工具另用云服务 | 已接官方模型桥、登录刷新、模型切换及上下文档位；实机主要验证 Hy4 | 逐模型能力与参数验证；不能用模型调用成功代替搜索、媒体、记忆等专用服务接通 |
| 文件和命令 | Read/Write/Edit/MultiEdit、Bash、Glob/Grep、ViewImage及平台工具；修改前备份 | 默认配置启用 read/edit/write/bash/grep/find/ls，目录隔离、自动/手动审批已接 | 参数语义、批量编辑和原生变更协议尚非逐项兼容；补文件状态、Diff及回退 |
| 附件与文档 | 文件/图片工具和原生资源上下文；还存在独立媒体/资料工具 | 本地图片、UTF-8文本、选区、PDF/DOCX/XLSX/PPTX及扫描PDF OCR已接，文档已实机 | 远端网盘/知识库文件引用、无路径粘贴图片、Office图片图表、音视频输入；当前文字解析不等于完整多模态能力 |
| Web搜索和网页 | WebSearch调用 `/agenttool/v1/search`；WebFetch有远端解析与本地回退路径 | 未接原版专用搜索/网页工具 | 检索服务、网页提取、来源引用、网络策略、超时和取消；自配MCP能覆盖部分需求，但不等于内置工具已映射 |
| 浏览器和桌面操作 | daemon提供browserUse/computerUse宿主；CLI含ComputerUse执行代码并受macOS/开关约束 | 未接内置浏览器和ComputerUse | 会话租约、页面/窗口归属、截图、输入、下载、权限及释放；Bash调用浏览器不等于完成这些合同 |
| 计划、待办与用户问答 | PlanMode、Task CRUD、Todo、AskUserQuestion、结构化表单 | 原生计划审批/调整未接；通用input/select/editor未接，只接受控工具确认 | 显式计划状态、步骤和审批/调整；通用问答类型、答案回传与取消，避免将业务问答当工具授权 |
| 子Agent、团队与协作 | Agent支持模型、resume、max_turns、后台任务及可选worktree；还存在Team、消息、Agent Home等代码 | 子Agent/团队投影为空，未集成执行器 | 子任务树、身份与权限继承、模型桥上下文、并发/预算、结果归并、取消传播、重启恢复；协作类还依赖额外服务 |
| 后台任务与执行中消息 | 后台Bash、输出/终止、TaskOutput/Stop、Monitor；会话支持steer | 前台Bash、流式状态及停止已接；后台终端为空，队列和执行中补充未接 | 任务注册、日志增量、独立取消、进程回收、重连及唤醒；将Pi steer/follow_up映射为明确的轮次与队列状态 |
| 记忆 | SaveMemory；MemoryRecall/Update调用云端memPlatformService | 保留会话历史；没有接入原版跨会话记忆服务 | 用户/项目隔离、记忆提取与检索、注入、更新/删除及审计；会话恢复、摘要或AGENTS文件不能等同云记忆 |
| Expert、Skill、插件 | 原生Skill还处理调用策略、参数模板、baseDirectory、fork Agent/model及hooks | 指令型Expert、显式选择SKILL.md及资源目录已接 | 插件/团队Expert、技能模型/子任务、工具权限、hooks与插件生命周期；脚本可以经Bash执行，不代表原生Skill语义已兼容 |
| MCP与业务连接器 | tools发现/委派、资源列表/读取、延迟加载、连接等待；daemon提供业务运行环境 | 已接已启用/信任/ready的managed connector和user MCP，覆盖HTTP/SSE及普通stdio | Buddy/plugin/first-party、CLI型连接器、localRoute、MCP resources/prompts及状态型长连接；需逐类认证和生命周期适配 |
| 上下文、压缩与推理设置 | 会话配置、clear/compact控制、模型和权限模式 | 300K/600K/960K等受模型约束的档位与当前总量统计已接；分类明细未接 | 手动compact、压缩阈值和推理档位未完整映射，详见下一节 |
| 文件产物、Diff、检查点 | CLI修改前checkpoint、daemon变更和原生回退/重试协议 | 工具能生成文件；原生artifacts/files/changes等集合为空，diff能力声明为false | 文件产物索引、前后快照、变更manifest、原生预览和Diff；有可验证快照后再做回退 |
| 历史、分支和导出 | 原生resume/fork/rollback及检查点相关路径 | Pi会话恢复已接；旧原生历史只读；fork、resend、rewind、从消息恢复、完整分享/归档未接 | Host turn/message与Pi entry映射，分支、重试、导出及分享权限；崩溃恢复目前标记中断，不自动续跑工具 |
| 工作区和开发语义 | 原版含Enter/LeaveWorktree及LSP类；lite-wb会裁剪部分能力桶 | 日期目录已接；未接worktree管理器或LSP | 按开发场景补worktree与语言服务；原版实际启用LSP仍未证实，不把类存在当默认支持 |
| 媒体生成与资料上传 | ImageGen/VideoGen/AudioTranscribe/LibraryUpload有专用执行实现 | 未接原版媒体生成或资料上传服务 | 专用模型/服务目录、权益、认证、上传、异步进度、产物回传；图片输入不等于图像生成 |
| 定时、助理和云执行 | 部分调度/内置工具属于daemon或云端，不能全归给CLI | 本地Pi façade没有云任务和调度执行合同；保留页面不构成接入证明 | 单独核对后台runner、账号和任务归属、触发与取消、失败重试及重启；不能据此直接断言所有原生云页面失效 |
| 权限和隔离 | 原版工具控制、hooks、沙箱、审批与外发检查是组合策略 | 自动/手动审批与受控MCP授权已接；不提供等价OS沙箱 | 若企业交付要求隔离，需明确路径/网络/进程策略；“允许完全访问”与日期目录均不提供隔离 |

### 两处应优先消除的配置落差

原生界面保留后，尤其要防止“界面设置了，执行器没有使用”的情况：

- `setThoughtLevel`目前仅保存renderer局部值，Pi启动参数仍固定`--thinking off`。这说明原生推理档位没有按用户选择传入Pi，**不等于已证明模型服务端完全不思考**。
- `setPreMessageCompactPct`是空实现，手动`compact`也返回不支持。不能把原生压缩比例当已生效；同时也**不能据此认定Pi自动压缩关闭**，当前适配并未统一控制并验证该策略。

对应入口是[原生配置 façade](../pi-harness/src/renderer/source.js)及[Pi启动与会话实现](../pi-harness/src/pi-harness.mjs)。当前窗口长度适配与上述两项是不同功能，不能混为一项“上下文设置已全部接通”。

同样需要区分知识库页面与执行工具：乐享或资料库页面可以展示内容，不代表Pi已经获得对应的搜索、资源读取和引用能力。需要接通明确授权的检索/读取工具，或下载所选文件后进入本地解析链；不能从页面可打开推导模型已能使用其全部内容。

## Pi已有机制与需要新建的服务

Pi 1.4.0自身有`steer`、`follow_up`、队列清理、`set_thinking_level`、`compact`、`set_auto_compaction`、retry控制、fork/clone、session tree和HTML导出等RPC。当前项目只包装并暴露了其中一部分，因此很多补齐工作发生在Host状态和原生界面映射，不必重新实现模型循环。[E5]

Pi扩展可以注册工具、MCP和命令，订阅context/tool/turn等事件，也支持持久状态。随包有plan-mode、todo、subagent和git-checkpoint示例，但它们没有自动成为金融buddy的功能：

- 当前启动显式带有`--no-extensions --no-skills --no-prompt-templates --no-mcp --no-context-files`，仅加载受控扩展。示例随依赖存在，不表示已加载。
- Pi默认跳过sub-agents和plan mode；示例可参考，原生任务树、权限、恢复和UI仍需实现。
- RPC不能直接转发自定义终端组件；示例的TUI界面不能直接显示成WorkBuddy原生计划卡或子任务树。
- Pi的packages和hooks有自己的语义，不与WorkBuddy插件manifest、hook配置或企业业务服务天然兼容。
- 在本次检查的Pi随包README/docs/examples范围内，没有发现可直接替代原版云记忆、浏览器/桌面操作、LSP和持久后台任务管理的默认专用实现；这不是对整个第三方Pi生态的不存在证明。

## 建议实施顺序与验收标准

| 优先级 | 补齐项目 | 主要接入位置 | 可以判定完成的验证 |
| --- | --- | --- | --- |
| P0 | 推理档位、手动压缩、压缩阈值的真实生效 | Pi RPC → Host配置/状态 → 原生config setter及事件 | 用合成对话检查实际请求参数、压缩结果和重启恢复；运行中修改有明确边界；不再仅改变显示值 |
| P0 | 产物和文件变更面板 | 工具事件 → 文件前后状态/快照 → artifacts/files/changes/manifest → 原生预览/Diff | 生成文档后界面能定位并打开；编辑显示真实差异；文件被外部修改时回退拒绝覆盖；两任务不串文件 |
| P1 | 常用业务工具：搜索、网页/浏览器、知识库、CLI型连接器、MCP资源 | 延续现有受控bridge；按来源/能力增加独立adapter，凭据留在daemon | 用客户实际最常用的一个工具贯通发现、授权、执行、结果、超时、取消、账号切换与重启；不以Mock成功替代真实服务验收 |
| P1 | ask-user、计划状态、执行中补充/排队及后台任务 | 独立交互类型、Pi steer/follow_up、任务注册表和原生事件投影 | 问答可回复/取消；计划可批准/调整；排队归属明确；后台输出可回连、独立停止，退出策略可说明 |
| P1 | Skill和插件运行语义 | native context → 受控Pi扩展 → 调用策略、参数、模型/子任务和权限映射 | 一项带资源与参数的真实Skill贯通；fork/hooks按显式策略启用；清除或禁用后不残留指令/工具 |
| P2 | 分支、重试、从消息继续、导出/分享 | Host与Pi session entry身份映射 | 分支不串历史；重试不重复有副作用的工具；分享/导出有明确内容范围 |
| P2 | 记忆、子Agent/团队、worktree、媒体/桌面能力 | 按需求分别建设服务或执行器扩展 | 验证账号/项目隔离、权限继承、预算、取消、进程回收、恢复和产物归属；不要只验工具名能显示 |
| 企业环境按需必选 | 执行隔离与外发策略 | OS/进程与网络策略层、工具授权层 | 用越界路径、外连、子进程和权限继承测试验证约束；与自动审批开关分别验收 |

办公与金融场景建议先完成P0，再接真实使用的检索/知识库和业务连接器。以代码开发为主时，可提前安排worktree和LSP。没有依据承诺固定工期，也不建议为追平工具数量一次性开放全部扩展或执行权限。

## 本轮未解决的验证问题

1. 未采集原版当前账号的实际工具目录及全部feature flags，不能保证每个实现候选在当前产品中启用。
2. 只看到枚举或配置引用的NotebookEdit、Cron、Artifact等，未据此认定为lite-wb已提供的独立工具；它们可能依赖裁剪桶、动态provider、daemon或其他包。
3. 未验证当前账号的搜索、云记忆、媒体、资料上传、ComputerUse和业务CLI服务可用性；也没有重放真实业务任务。
4. Pi自动压缩、所有官方模型、所有MCP/技能的端到端行为未在本轮实测。0.4.4文档/Hy4验收不能代替这些验证。

## 证据索引

完整本机证据位于被Git忽略的`evidence/pi-capability-audit-20261027/`，不将原版完整执行包、账号或业务数据纳入源码提交。

| 索引 | 可复核来源 |
| --- | --- |
| E1 | `main/findings.json`：CLI路径解析、ACP控制方法、delegate、checkpoint、会话恢复及后台/子任务；每段保留原成员SHA-256和精确UTF-8半开字节范围 |
| E2 | 同上`daemon-business-env`、`daemon-builtins`、`desktop-browser-computer`；来自原版`main/server.js`及`main/daemon-app-server-main.js` |
| E3 | `native-cli/rea-subset/provenance.json`：ToolManager.init字节5727443–5728691；buildTools 1465802–1467832；isEnabled 1470378–1471354；修改前checkpoint 5766329–5767075；另见`tool-constructors.json`和`packaged-agent-defaults.json` |
| E4 | [Pi执行器](../pi-harness/src/pi-harness.mjs)、[原生façade](../pi-harness/src/renderer/source.js)、[内容映射](../pi-harness/src/native-context.mjs)、[MCP服务](../pi-harness/src/native-mcp-service.cjs)、[当前文档验收](workbuddy-pi-documents.md) |
| E5 | Pi 1.4.0随包`docs/rpc-commands.md`（steer 46、follow_up 70、thinking 274、compact 367、auto_compaction 406、fork 610、tree 719）；`docs/extensions.md`、`docs/packages.md`及`examples/extensions/`；本项目[RPC封装](../pi-harness/src/pi-rpc.mjs) |

REA分析引用及限制：

- main模块有界子集父Evidence：`ev_81a47db6b12533eaee707afb9956e1b302f08b8e1158440cf97c861c1085fbae`；5个原样成员、1,006,460字节，5个JS解析、0语法失败。`conversations.js`的语义图受资源限制，静态事实保留；不是完整应用调用图。
- CLI有界方法子集父Evidence：`ev_d1993e4e8082d08d8ee1864028f86bd990b6544f3fdd2866644866325429180f`；12个工具/装配类片段语法解析完成。外层`Captured*`类是明确标注的分析包装，内部方法有原样字节和SHA来源；不能把包装类名当原版导出接口。
- CLI子集中另一个launcher截取片段有未配对闭合符，REA记录1个parse failure。该问题属于截取胶囊，不是原版完整bin脚本损坏；launcher分流结论仅依据原样字节人工核对。
- 两组语义覆盖均为partial/unknown，静态引用和调用候选不证明运行时注册、可达、授权生效或云服务执行成功。本报告使用原样方法、配置声明与当前适配源码交叉核对，不把REA全量分析当作已完成。
