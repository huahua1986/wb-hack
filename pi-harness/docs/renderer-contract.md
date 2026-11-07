# WorkBuddy 5.9.1 原生界面接入合同

`src/renderer/source.js` 和 `protocol.js` 基于用户已有 WorkBuddy Host 0.9.4 的 Renderer Mux，针对本机原版 WorkBuddy 5.9.1 重新核对并适配。旧项目的 5.6.2 版本声明和旧消息更新合同不作为当前版本兼容证据。

入口是现有 Renderer SDK 的 `wb.$provide("conversations", mux)`。只有本次 Host 所属命名空间的外部会话被接管，其他会话转发给原来的 `wb.conversations`。新增“原生 / Pi 外部”切换；取消接入时恢复原 namespace。没有修改安装包，也没有调用外部模型时经过认证网关。

## 0.2.7 原生 UI 模式

0.3.0 增加原生内容映射，当前附件/Expert/技能/MCP 的支持范围和授权合同以[原生内容说明](../../docs/workbuddy-pi-native-content.md)为准；下文保留早期模式的历史边界。

`exclusive:true, nativeUi:true` 将执行独占与界面接管分开：原版首页、导航、侧栏与模型/输入组件不替换，不自动跳转或创建空任务。只在创建/发送等会话服务边界承接Pi，首条消息仍走原版stash/start/sendIntent顺序；传入model与空cwd按原生语义处理。列表按workspacePath/excludeWorkspace、trace关联的local listChange权威快照与分页合并，自动工作区计根任务。旧原生本地历史通过只读facade暴露读取，拒绝旧执行入口。

原生模型目录正常主分支是config:getProductConfiguration，不需要controller.models或手写模型DOM；旧“首页等待CLI必须跳转”注释已纠正。UI与功能支持范围及证据见[原生界面说明](../../docs/workbuddy-pi-native-ui.md)。以下仅为nativeUi=false的历史模式合同，仍保留旧实验兼容。

## Pi-only 候选包模式

`buildRendererSource({ exclusive: true })` 为候选包提供仅使用 Pi 的界面合同；省略该项或传入 `false`，继续使用上述原生 / Pi 并存实验模式。打包启动层需要明确传入此值，它不是 WorkBuddy 自带的 CLI 参数。

该模式保留 WorkBuddy 名称及官方认证流程，执行引擎仅显示“Pi 引擎”，没有“原生”切换入口。首页和侧栏“新建任务”先打开真实 Pi controller，避免等待已移除的原生模型服务；直接调用 `wb.conversations.create()` 也创建 Pi 线程；云端任务明确报不支持，不回退原生执行器。Pi 使用自己的模型目录和凭据，原生模型选择入口不作为 Pi 配置来源。

新任务以实时请求记录判断空白会话，避免把发生过消息更新的旧线程快照再次当作新任务。原生会话列表、原生会话控制器不在此模式暴露，避免历史会话重新触发默认执行器。Pi 历史、当前线程与取消操作继续使用同一 Host 合同。原版更多菜单、知识库页面及非会话路由保持；仅在首页或 Pi 会话中应用文本输入和不支持功能的控件限制。没有新增图片、原生技能、审批或 MCP 能力。

Renderer 等待 5.9.1 原生壳的 `wb.conversations`、`.teams-container` 等合同就绪，并确认官方 `wb.account.status()` 为 `authenticated`，不生成登录假态、修改官方登录地址或提前创建 Pi 线程。官方登录页面等待不受默认两分钟合同超时限制；登录后的合同和版本仍会检查。Pi 启动或导航失败时，已安装的 mux 保留失败门控，后续创建明确报错，不恢复为原生任务创建；显式卸载 Renderer 仍恢复原 namespace，便于旧实验入口回退。

这是 Renderer 的任务路由边界。候选包还必须在主进程阻止内置 CLI 的预热、恢复和后台调用，并实际移除对应文件；仅通过这些界面测试不能证明打包结果已移除 CLI，也不能代替官方账号登录与候选应用现场验收。

登录弹窗出现时底层 DOM 可能已经存在，因此只检查会话壳会过早接管。Pi-only 模式以实际官方认证结果为门控，不把 DOM、超时或账号快照视为认证成功；登录后的新任务直接使用 Pi 控制器，不强行启用原生发送按钮。

## 5.9.1 的关键差异

原生 `requestUpdate` 回调现在要求第四个参数为 typed patches。原生消费者立即对它调用 `.some()`；IPC 合同也明确检查数组并在缺失时抛出 `typed patches are required`。只发送旧的三参数 ACP chunk 会导致流式阶段异常；完成后依赖历史重载显示结果并不能证明流式接入成功。

当前适配发送：

```js
listener(requestId, messageId, chunk, patches);

// 用户消息：完整内容替换。
{ kind: "user-content-replaced", requestId, content, context }

// 助手文本和工具：完整块按索引更新，text 为累计内容。
{ kind: "assistant-block-upserted", requestId, index, block, context }
```

`context` 携带 `timestamp`、`conversationRequestId` 和可用的 `responseModel`。块索引从 0 连续增长；不能将单个 delta 作为完整块替换。每次事件保留独立块快照。回合结束仍发送 `requestsChanged`、`historyLoaded` 和 `stateChange`，请求历史提供 `requestEntries()` 的 `requests`、`entries`、`historyReady`、`historyKnownEmpty`、`hasOlder`。

## Host 输入输出

Renderer 调用 `runtime.snapshot`、`ui.snapshot`、`ui.update`、`thread.create`、`thread.delete`、`thread.model.set`、`turn.start`、`turn.cancel`、`interaction.respond`。Host 应在服务端存储 `uiState.active`、`activeThreadId`、`selectedHarnessId`，重启后使用线程身份恢复，不依赖旧进程的临时 Renderer 命名空间。

5.9.1 的侧栏导航可能直接加载会话而不调用 `setCurrentConversation`。因此当前路由观察及其 `get(id)` 路径都会确认实际正在显示的已有外部线程，并同步上述选择。所有正常选择写入共享串行队列，同一选择共用 Promise，避免 DOM 观察触发重复 RPC 或过期选择覆盖较新的选择。同源切换也会等待该同步；原生更多、乐享和首页路由不额外改写此状态。

```js
{
  defaultHarnessId: "pi",
  harnesses: [{
    harness: { id: "pi", label: "Pi Agent" },
    threads: [{
      id: "thread-id", harnessId: "pi", title: "示例", cwd: "/workspace",
      status: "idle", createdAt: "ISO timestamp", updatedAt: "ISO timestamp",
      models: { currentModelId: "model-id", availableModels: [{ id: "model-id", name: "显示名" }] },
      turns: [{ id: "turn-id", prompt: "问题", status: "completed", items: [] }]
    }]
  }]
}
```

实时事件形状为 `{ seq, type, harnessId, threadId, turnId, payload }`。`message.delta` 的 payload 为 `{ messageId, delta }`；`tool.created` / `tool.updated` 为 `{ item: { id, type: "tool", name, input, output, status } }`；`turn.completed` 为 `{ turn: { id, status: "completed", stopReason: "end_turn", items } }`，其中 items 为最终完整内容。取消和失败分别为 `turn.cancelled`、`turn.failed`。审批使用 `interaction.requested` / `interaction.resolved`；本次 Pi 是否产生审批事件由 Host 的实际工具策略决定。

## 范围与验证边界

只接受纯文本用户输入，资源引用等输入在调用 Host 前明确拒绝。没有伪装成支持 WorkBuddy 原生技能、乐享引用、MCP relay、专家或工作区权限策略。Rewind、checkpoint、fork 等未适配操作返回不支持；重命名和外部置顶目前是 Renderer 内存状态，不承诺跨进程保存。

`node --test test/renderer.test.mjs` 的 20 项测试覆盖消息配对、原生透传、版本拒绝、持久线程选择恢复、导航失败回退、取消接管清理、文本和工具流式 typed patches、结束历史刷新及失败重试；包括“Pi→原生→乐享→侧栏直接回到 Pi”的选择持久化、观察事件去重及重启恢复。其中 7 项专门验证 Pi-only 引擎展示、原生控制器与列表隔离、首页与新建路由、官方登录壳等待、失败门控、知识库路由及重启线程身份恢复。它是受控界面合同测试，不代替原版客户端现场验收。

## 证据

原版 `app.asar` SHA-256：`1fc0a56ddec5437d4dc55a55ba1c028b291ab29cb17306500827015987424233`。

本地取证目录 `evidence/pi-harness-591-hook/` 保留 ASAR 成员哈希、原始 UTF-8/UTF-16 范围及 7 个未经改写的精确片段。REA 父证据 `ev_4a54d80513a463f6aad272e230fd60d12307325ff8409a1ed64a7e203b6c2f4a`，摘要证据 `ev_ecad37013d4167a4ee29b2aa62bb5053a940a2d8a55c3c2e5d562f48af7df1a6`：读取 22,174 字节、7 个 JavaScript 片段，0 解析错误。静态分析有 1,197 项语义未知，不能视为运行时验证。
