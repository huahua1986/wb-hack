# WorkBuddy 接入客户私有化腾讯乐享：调查结论

调查及实现时间：2026-10-19。目标：保留原版 WorkBuddy 安装包、私有账号认证、自定义模型直连，让内置乐享入口使用客户私有地址。当前代码为后端 0.3.3、客户端 0.1.3，已完成本地 Mock 和原版客户端验证，未部署到客户远程服务器。

## 结论

WorkBuddy 5.8.3 已包含乐享私有域名配置：`privateHost.lexiangHost` 与 `privateHost.lexiangMCP`。可以沿用现有外置产品配置机制下发，不需要改安装包。

内置乐享同时涉及网页、临时登录、连接器授权、MCP 查询和 SPAPI；部分原生页面链接仍固定生成公网域名。当前已在 auth-gateway 中补充 Mock 和可配置 bridge 适配，并通过运行时钩子定向残余链接。客户实际乐享的版本、接口和身份体系尚未提供，故真实系统兼容仍待联调。

## 已确认的地址配置

以下为启动组件实际生成的 **WorkBuddy 产品配置片段**；管理员应填写后文的客户端 `lexiang` 配置，不直接编辑每次启动都会重新生成的产品文件。域名仅为示例：

```json
{
  "privateHost": {
    "lexiangHost": "https://knowledge.customer.example",
    "lexiangMCP": "https://knowledge-mcp.customer.example"
  },
  "productFeatures": {
    "TencentLexiangKnowledge": true
  }
}
```

| 字段/机制 | 已确认用途 | 限制 |
| --- | --- | --- |
| `privateHost.lexiangHost` | 内嵌知识库 `/wb`、空间 `/wb/spaces/...` 的 origin；主进程 SPAPI、许可检查的 origin；部分 URL 和 Cookie 域名判断 | 原生页面的部分链接不读此字段；许可检查是否触发受产品及身份分支影响 |
| `privateHost.lexiangMCP` | 生成乐享连接器的企业专有环境变体 | 在该变体构建分支中自动拼接 `/api/mcp?preset=meta`，不是任意完整 MCP 路径配置；是否选中变体取决于账号身份和连接器定义 |
| `TencentLexiangKnowledge` | 乐享功能入口开关 | 开启入口不代表完成授权 |
| `WORKBUDDY_DEV_ENDPOINT_OVERRIDE` | WorkBuddy 主后端及其相对协议请求 | 单独设置此变量不能覆盖所有乐享地址 |

地址解析使用 `new URL(...).origin`，会去掉路径前缀。例如 `https://host/lexiang` 会变成 `https://host`，所以应提供独立域名或在该 origin 的根路径正确承载接口；不能直接把一个带子目录的地址当作已兼容入口。

## 为什么还需要后端适配

```mermaid
flowchart LR
    W[原版 WorkBuddy] -->|登录与产品配置| G[现有 auth-gateway]
    W -->|临时登录、连接器令牌、目录 MCP| A[乐享协议适配层]
    G --- A
    A -->|用户身份映射、SSO、授权 API| L[客户私有乐享]
    W -->|网页、预览及部分 SPAPI| L
    W -->|自定义模型配置| M[客户模型服务]
```

当前客户端中可确认的协议包括：

| 协议 | 用途 | 实现要求 |
| --- | --- | --- |
| `POST /v2/as/connector/oauth/{name}/temp-login-url` | 原生模式的乐享临时登录 | 根据当前用户换取客户乐享认可的登录链接；返回 `code:0,data.login_url` |
| `POST /console/enterprises/{enterpriseId}/lexiang/temp-login-url` | 企业内嵌模式临时登录 | 该分支先要求企业 ID，随后请求登录链接 |
| `GET /v2/as/connector/oauth/{name}/accesstoken` | 乐享专用访问令牌 | 返回客户端可用于目标乐享服务的令牌，不能直接沿用私有网关会话 token |
| `POST /console/agent-gateway/lexiang-ol/mcp` | 原生目录、搜索等 MCP 工具请求 | 接收 `tools/call → call_rpc → tool_name`，转发或转换为客户版实际 API |
| `/console/agent-gateway/lexiang-ol/api/...` | `exclusive`/`premise` 账号的网关分支 | 仅在对应实际账号类型下出现，不应为切换 UI 而伪造账号类型 |
| 私有乐享 origin 下的 `/spapi/...` | 部分内容及上传相关操作 | 确认客户版本具备相同接口及授权要求 |
| `/tapi/account/v1/check-license`、`/tapi/account/v1/check-company-status` | 许可/企业状态查询 | 仅在被选中的功能分支中接入客户真实状态，不能伪造授权成功 |

`name` 的常量标识为 `lexiang-ol`，访问令牌请求还经过 `connectorService.resolveOauthName()`；实际部署应按连接器映射确认名称。

原生模式调用目录 MCP 时，地址取 WorkBuddy 主 endpoint，即现有私有网关。只配置 `lexiangMCP` 不会把这条原生目录查询直接迁移到客户 MCP。

网页模式也有条件：`useLexiangLibraryMode()` 仅在企业版本且乐享 OneID 应用状态为 `enabled` 时返回 `iframe`，其余为 `native`。当前网关返回的是 `personal` 账号，不含企业 ID，因此不能仅靠填写域名就假定进入企业内嵌模式。必须保留真实身份语义，设计网关用户到客户乐享成员的映射。

官方分别提供 [SSO 接入文档](https://lexiangla.com/wiki/api/32001.html) 和 [知识库开放接口文档](https://lexiang.tencent.com/wiki/api/)。网页 SSO 登录与后端 API 凭证需要分别确认；这些公开文档不能证明客户某个私有版具备 WorkBuddy 使用的内部接口。

## 已实现的接入点

实现集中在安装包之外：

1. 客户端 `lexiang.webOrigin/mcpOrigin` 持久化到用户设置，每次生成外置 `product.local.json` 时写入 `privateHost`。配置变更纳入启动所有权判断，不能把旧地址的既有进程误判为已应用新配置。
2. auth-gateway 增加状态、连接、解除连接、短期令牌、临时登录链接与 MCP 适配。Mock 凭据和网页登录票据关联现有会话，数据库仅保存哈希；管理员释放或禁用账号后立即拒绝旧 Mock 访问。bridge 模式服务凭据只存在后端；发给客户端的是客户侧用户短期令牌，用于客户 SPAPI，最长 5 分钟且不超过主会话有效期。
3. `/v3/config` 返回公开的私有地址和功能开关，但继续保持 `config.disabled:true` 与空默认模型列表。当前以外置客户端配置为持久入口，不依赖远程配置轮询。后台与客户端地址必须由管理员对应配置。
4. 临时登录接口将旧公网目标转换并校验为客户 origin。现有短时 Inspector 在原版入口执行前安装内存钩子，定向 `shell.openExternal`、现有及新建 webContents 的乐享导航。只匹配明确的乐享域名边界，清除旧 Token、OAuth query、fragment，以及跨 origin 加载时的 POST、额外请求头和 referrer，随后关闭 Inspector。它不拦截模型 API，不是网络防火墙。
5. 本地 Mock 使用真实的本地账号密码与既有单会话机制；只监听回环地址，按账号隔离知识库，返回明确的 Mock 内容。生产后端归档不包含 Mock 实现或测试账号库。

## 客户端配置

在用户 `state/workbuddy-launcher.json` 或开发启动器配置中增加下面的对象，保留原有 `gateway` 等字段：

```json
{
  "lexiang": {
    "enabled": true,
    "webOrigin": "https://knowledge.customer.example",
    "mcpOrigin": "https://knowledge-mcp.customer.example"
  }
}
```

本地测试将两个地址都设为 `http://127.0.0.1:8791`；关闭入口使用 `"lexiang":{"enabled":false}`。地址必须是无路径、查询、用户信息的 origin，远程只允许 HTTPS。客户端配置不接受账号、Token、SSO 密钥等额外字段。打包可传 `--lexiang-config client-distribution/lexiang.example.json`，把公开地址预置到客户端交付包。

## 本地 Mock 启动

在仓库根目录运行（Node 24+）：

```sh
node auth-gateway/scripts/lexiang-mock.mjs --port 8791 --data-dir ./auth-gateway/data/lexiang-mock
```

首次创建 `lexiang-demo` 测试账号，随机密码只写入指定数据目录的 `initial-credentials.json`，权限 0600，不打印到终端。保留此数据目录再启动即复用账号、有效会话和知识库。该脚本只随源码提供，不包含在生产后端归档中。

客户端 `gateway` 同时指向 `http://127.0.0.1:8791`，`lexiang.webOrigin/mcpOrigin` 使用相同地址。首次正常登录后，打开“更多 → 乐享知识库”。可从“添加文件 → 乐享知识库”进入内容选择器，输入关键词并按回车搜索；点击右侧文档可验证预览。完整退出 WorkBuddy 后按同一受控入口启动，应免登录恢复。切换认证域前保管旧开发登录态；不同环境使用独立 profile 和账号库，不覆盖正式账号。

## 客户服务端 bridge 配置

以 `auth-gateway/examples/lexiang.bridge.example.json` 为模板，将 `GATEWAY_LEXIANG_CONFIG_FILE` 指向服务器上的配置文件。配置包含私有网页 origin、完整 MCP URL、bridge origin、凭据文件路径与显式的本地用户名到乐享成员 ID 映射。bridge 密钥是至少 32 字符的无空白字符串，单独存入权限 0600 的文件，不进入客户端或公开包。内网 CA 应通过系统/Node 受信任证书配置，不关闭 TLS 验证。

这里的 bridge 是需要按客户版本实现或接入的**服务端身份适配合同**，不是已经证明所有私有乐享版本自带这些接口：

| 接口 | 合同 |
| --- | --- |
| `POST {bridgeOrigin}/session` | 服务端 Bearer 凭据认证；请求 `{subject,session_id,session_expires_at}`，返回 `{access_token,expires_at}` 或 `code:0,data:{...}`。返回的是对应成员的短期用户令牌，最长 300 秒，不能使用覆盖所有成员的管理凭据代替 |
| `POST {bridgeOrigin}/login-url` | 相同服务凭据与会话身份，加 `intend_url`；返回 `{login_url}`。最终登录 origin 必须在 `loginOrigins` 中 |
| `POST {gateway}/private/lexiang/bridge/introspect` | bridge 使用同一服务凭据，提交 `{subject,session_id}`，获得 `code:0,data:{active,expires_at?}`。未授权服务、过期/撤销/禁用账号、解除连接或成员不匹配均不能通过 |
| 配置的 `mcpUrl` | 网关用该成员短期令牌转发原版 JSON-RPC 请求；SPAPI 由原版客户端使用用户令牌直接访问客户乐享 |

**客户 bridge 和乐享接入层必须把用户令牌及网页会话绑定到 `session_id`，使用上述实时校验或等效撤销机制，并在校验不可用时拒绝访问。** 当前实现提供校验接口，不能自动吊销不执行此合同的客户网页登录 Cookie。Mock 的立即撤销结果不能代替真实客户系统的撤销验收。桥接请求禁止自动跟随重定向，具有超时和响应大小上限，日志不记录请求体、查询或凭据。

## 本次原版客户端验收

验证使用 WorkBuddy 5.8.3、独立本地 profile、`http://127.0.0.1:8791` 和本地测试账号：

- 通过原版登录按钮和网页账号密码表单完成登录，显示“私有乐享测试账号”。
- “更多 → 乐享知识库”显示 Mock 团队、个人/团队知识库和两篇文档，使用原版 native 视图。
- 原版内容选择器输入“重启”并回车，显示对应文档；点击文档，在原版 webview 预览中显示本地 Mock 内容。
- “打开乐享”的浏览器最终地址为本地 `/spaces/...`，没有退回默认网页地址。
- 同时完整退出 WorkBuddy、重启本地后端，再用同一外置配置启动，无需重新登录；产品名称、乐享目录和 `qwen3.8:27b` 自定义模型选择恢复。
- 自动化完整回归 **124/124 通过**，覆盖账号隔离、团队检索范围、一次性票据、防目标跳转、管理员释放、服务端重启、140 次重复预览、bridge 成员映射和服务凭据隔离等。后端 0.3.3 生产归档与客户端 0.1.3 内部测试 PKG/ZIP 均构建成功，客户端 21 个清单文件校验通过。安装包核心文件与复制的模型配置哈希保持一致。结果记录在本机证据目录，不作为生产现场验收。

本次 Mock 使用 `personal/native` 路径，没有伪造企业身份或商业许可。截图中的企业整页 iframe、客户实际 SSO/SPAPI/MCP、上传/导入/权限编辑及知识附件的模型工具调用，仍需客户环境进一步验证。本次只确认模型配置和已选模型保留、乐享适配不接管模型流量，没有重新进行模型推理性能测试。

如果客户仅提供普通开放 API，而没有 WorkBuddy 所需的 `/wb`、SPAPI 或 MCP 协议，需要评估协议转换覆盖范围。也可另交付一个私有知识库连接器提供检索与读取，但该方案不等于完整复用内置乐享界面。

## 验证与证据

- 安装版本：WorkBuddy **5.8.3**；`app.asar` SHA-256：`a7eff702411704d140d7d8d706fe9e711d9b13e304928481c9eba0af9c06f731`。
- 从当前安装目录只读提取相关代码；主 ASAR 与外置 `app.asar.unpacked` 文件分别记录成员 SHA-256。证据目录：`evidence/lexiang-private-audit-20261019/`，不纳入公开交付。
- REA 对 5 个原始/带范围溯源的切片完成语法分析，47,096 字节、0 语法失败。父 Evidence：`ev_97491132a8f3ce4a81a0cbe1c5a1af67649e15a4418fce9304ca603d249eed75`；摘要：`ev_d5b3c6282ab2f982377dd487e57e47532bcb5558961e0476ba37eb0e95f13577`。静态语义仍有未知项，不代表完整应用调用链已验证。
- 按 API 名称执行的 REA 关系图追踪返回 `no-match`（`ev_e1542290a0b6a5058e09137a1664a12b1725b27eb9f8d2d0a5da5e84e6cde1c0`），未将其当作功能不存在的证据。上述结论依据具体源码消费者和受控回放。
- 使用提取的原函数和依赖桩执行 **11 项无网络回放检查，全部通过**：私有 origin 优先、路径前缀剥离、主 endpoint 不会自动覆盖普通乐享域名、内嵌 URL、SPAPI 私有 origin、独立连接器 token、MCP 仍走网关、独立预览仍生成公网 URL 等。结果记录在 `replay-results.json`；这不是客户环境或客户端 UI 验收。

关键定位使用提取成员的 Unicode 字符偏移，切片溯源另提供 UTF-8 字节范围：

| 当前安装成员 | 定位 |
| --- | --- |
| `main/origins.js` | `resolveLexiangWebOriginWithPrivateHost`、`isLexiangWebOriginUrl` |
| `main/server.js` | `resolvePrivateHost` @2995127；`createTencentLexiangFacade` @3093510；`doFetchLexiangAccessToken` @3106804；`resolveLexiangOrigin` @3107358；`getLexiangGatewayBase` @3109063 |
| `main/server-side-access-token.js` | `connectorOauthTempLoginUrl` 与 `connectorEnterpriseTempLoginUrl` 注册及协议路径，约 @3480–4250 |
| `main/tar.js` | `buildEnterpriseVariantsFromProfile` @1020324；`deriveVpcMcpUrlFromProfile` @1021246 |
| `renderer/assets/contexts-BNN7VV-R.js` | `useLexiangLibraryMode` @4612903；`resolveLexiangPrivateHost` @6294162；`buildLexiangPageUrl` @6294342；`getLexiangLibraryEmbedUrl` @6294612 |

进入实际接入前，需要客户提供：私有乐享访问地址及版本、网页登录/SSO方式、可用 API/MCP 文档和服务地址、用户及权限映射规则、证书信任方式。账号密码、AppSecret、私钥通过客户的安全配置渠道提供，不写入说明文档或公开交付包。
