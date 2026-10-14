# WorkBuddy 私有认证与内容后端

为原版 WorkBuddy 提供本地账号密码登录、专家/技能/连接器目录管理和版本化安装包分发。0.3.1 默认启用单账号单会话，已有有效会话时拒绝新的密码登录。认证兼容 5.8.0/5.8.1，内容协议按当前 5.8.1 核对和联调。模型由客户端的自定义模型设置配置，使用独立 URL 和 API key 直连模型服务。后端不提供模型目录、模型转发、腾讯上游凭证、虚构额度或计费接口。

正式部署使用 Linux systemd + Nginx，安装、升级、回滚、账号管理和备份恢复步骤见 [部署说明](deploy/README.md)。发布包不包含 Mock、账号数据、客户端 profile 或 WorkBuddy 安装包。

实现依据是安装包静态逆向、原始消费者回放和原版客户端联调。认证与私有测试内容的本机验收记录在上层 `evidence/`，不进入 Git；开发测试需要的有限协议片段已纳入 `test/fixtures/`。项目入口、版本范围和已验证边界见 [根 README](../README.md)，本机验收不能替代其他版本、第三方连接器业务或生产现场验收。

## 启动认证网关

### 本机 Mock 登录

只验证 WorkBuddy 登录协议时，可启动独立 mock：

```sh
cd auth-gateway
npm run mock
```

地址为 `http://127.0.0.1:8787`，与工作区 `workbuddy-launcher.json` 的默认 gateway 一致。Mock 只监听 loopback，使用独立 `mock-data`，不会复用正式账号数据库。浏览器登录页显示“以 Mock 测试账号登录”按钮，不需要真实密码；领取 token、查询账号与刷新仍使用正常协议。只应在本机测试中使用，不代表腾讯身份、额度或模型权限。

先通过双击启动器启动 WorkBuddy，再点击客户端登录，并在打开的网页点击该按钮。登录完成后，客户端账号应显示“Mock 测试账号”。链接有效期为 5 分钟，超时后需要从客户端重新发起登录。路径与状态日志在 `mock-logs/requests.jsonl`，不记录密码、查询参数或 token。用 Ctrl+C 停止 mock；以后重复运行以上命令即可继续测试。Mock 需要单独运行，不会被客户端启动器隐式启动。

HTTP 测试覆盖模拟登录提交、领取 token、查询账号与刷新。实际客户端验收还需同时核对账号显示和网关日志：`POST /mock/login` 应返回 303，随后 `GET /v2/plugin/account` 应返回 200。仅有轮询返回 HTTP 200 不能证明登录成功，因为等待中的业务响应也使用 HTTP 200。Mock 不等于真实外部身份源或模型服务验收。

### 账号密码服务

需要 Node.js 24 或更高版本；使用内置 HTTP、crypto 和 SQLite，无第三方依赖，无需 npm install。

```sh
cd auth-gateway
npm run user -- add feiz --display-name feiz
npm start
```

创建账号时在终端隐藏输入密码并确认，至少 15 个 Unicode 字符，最多 1024 UTF-8 字节。没有默认账号或默认密码。自动化创建账号可以把密码通过 stdin 输入，避免放到命令行参数、日志或仓库。默认服务地址为 `http://127.0.0.1:8787`。账号、会话数据库与用于加密一次性凭证交付的密钥放在 `./data`。

配置项见 `.env.example`。需要使用文件配置时，用 Node 的环境文件选项启动：

```sh
node --env-file=.env src/main.mjs
```

远程部署把 `GATEWAY_PUBLIC_URL` 配为实际 HTTPS origin，在 TLS 反向代理后运行；代理保留这个 origin 对应的 Host。HTTP 仅允许本机开发。示例在 `deploy/nginx.conf.example`。程序默认监听 loopback，不自动修改系统证书或关闭 TLS 校验。

账号管理：

```sh
npm run user -- list
npm run user -- set-password feiz
npm run user -- disable feiz
```

修改密码、停用账号会撤销此账号在网关的所有会话。这里没有用户自注册或 HTTP 管理账号接口。新密码使用带独立盐的 scrypt（N=32768、r=8、p=3）；现有 p=1 记录仍可验证，应通过重置密码升级。access/refresh token 只保存哈希，一次性交付和短暂刷新重试数据使用 AES-256-GCM 加密。SQLite 数据与密钥文件按私有权限创建。备份时停服务并保存完整 `data` 目录，不能只备份数据库而丢失 `delivery.key`。

## 单账号单会话与管理员释放

所有客户端必须连接同一个后端和账号库。每个启用账号最多保留一个有效会话；有效指未撤销且 refresh 会话期限未到，默认绝对期限 14 天。access token 到期、关闭 WorkBuddy 或断网不会自行释放名额；没有用请求间隔推断客户端是否在线。

密码校验通过后，在 SQLite `BEGIN IMMEDIATE` 事务中检查并签发会话。若已占用，网页登录返回 HTTP 409，显示“账号已有有效会话，请联系管理员释放会话后再登录”，不签发新 token，也不撤销原会话。密码错误仍返回普通认证失败；拒绝事件记录为 `login_rejected_active_session`，不记录密码或 token。

刷新、daemon/CLI 的并行刷新重试和客户端重启复用原会话，不占用新名额。网页登录完成但尚未领取凭证时会暂时占位；登录链接过期（创建 state 起 5 分钟）仍未领取的会话被撤销，避免无凭证客户端长期占位。

管理员在后端目录执行：

```sh
npm run session -- list tester
npm run session -- revoke tester --id <会话ID>
# 或释放该账号的全部会话：
npm run session -- revoke tester --all
```

原 access token、当前/上一代 refresh token 和尚未领取的凭证立即在后端失效；释放后可以重新登录。被拒绝的网页登录在 state 仍有效时可重试，链接超时则从 WorkBuddy 重新发起。无需重启后端。管理命令需本机数据目录权限，不开放匿名 HTTP 释放接口。部署环境对应命令为 `sudo workbuddy-auth session ...`。

升级前先备份完整数据。新后端启动时会处理旧库的多会话：每个账号保留最近使用的一条，按 `last_seen_at`、`created_at`、会话 ID 依次降序确定，其余撤销并清除待领取凭证，记录 `session_revoked_single_session`。单会话的已有账号保留原登录态；数据库 schema 仍为 2。回滚至旧后端代码会恢复其多会话签发行为，已经撤销的会话不会自动恢复。

这一限制针对共享后端的登录会话，不提供可信设备绑定。复制同一套 Bearer 凭据仍可能共享一个会话；每台电脑独立部署账号库也不会形成统一限制。模型直连保持原样，撤销后端会话不会吊销独立模型 API key，断网或本地 Ollama 调用不能由此后端强制停止。

2026-10-14 验证：完整测试 83 项通过，包括两个同时网页登录和两个 SQLite 进程连接竞争，以及真实管理 CLI 释放后的重新登录。本机原版 5.8.1 验证了拒绝提示、释放后回到登录页、重新登录和完整退出后的同一会话恢复；安装包与自定义模型配置哈希不变。记录在本机 `../evidence/single-session/`，未做两台实体电脑的现场验收。

## 私有内容管理与包分发

目录、版本和资产索引复用现有认证 SQLite 数据库；原账号和会话 schema 保持 2，独立 catalog schema 为 1。源文件和真实 tar.gz/ZIP 包保存在 `data/content/objects`，以 SHA256 定址，发布后不可覆盖。变更必须发布新版本；下架不删除历史文件。CLI 管理使用本机管理员权限和原审计库，没有匿名 HTTP 写接口。

准备与 manifest 同目录的源文件夹，再发布 JSON 清单。例如技能：

```json
{
  "kind": "skill",
  "id": "team-checklist",
  "name": "团队核验清单",
  "description": "本地文件和结果核验",
  "version": "1.0.0",
  "categoryId": "engineering",
  "tags": ["核验"],
  "metadata": { "categoryName": "研发", "allowedUsers": ["feiz"] },
  "sourceDir": "./skill"
}
```

`kind` 为 expert、skill 或 connector。sourceDir 必须是 manifest 所在目录下的相对路径；内容源不能与认证数据目录重叠，不允许软硬链接、路径穿越、跨平台文件名冲突或超限包。技能 ZIP 的根目录或唯一顶层目录应包含真实 SKILL.md；其 frontmatter.name 与 metadata.skillName/id 保持一致。专家源包含 `.codebuddy-plugin/plugin.json`、agent 和 skill 文件，metadata.pluginName/agentName 对应真实包声明；连接器源包含有效 plugin.json、mcp.json 和脚本/技能。服务端打包不执行发布的源码。

```sh
npm run catalog -- publish --manifest ./private-content/manifest.json
npm run catalog -- list skill
npm run catalog -- show skill team-checklist --version 1.0.0
npm run catalog -- disable skill team-checklist
npm run catalog -- enable skill team-checklist
```

读取市场 API 必须使用原 WorkBuddy 登录 Bearer。metadata.allowedUsers 可按本地用户名或 UID 限制可见范围；省略时向全部已登录用户提供内容。受限包通过与登录会话绑定的 15 分钟签名链接下载，篡改、过期、停用账号、撤销会话或下架条目后拒绝新下载。已安装到客户端的文件与独立模型 API key 不会因服务端撤销而被删除。

原版静态资源加载器不携带登录 Bearer。只有显式 `metadata.public:true` 且无 allowedUsers 的记录可进入匿名只读专家 manifest、静态专家 fallback 包及连接器整包；默认不公开，ACL 与公开标记不能同时使用。连接器初版使用 legacy 整包，这一分发路径不支持按账号拆分，请在内网提供经过明确公开授权的目录；非公开连接器记录不会被打进整包。自建 MCP 或第三方业务授权与目录分发是不同功能。本版不代替第三方 OAuth/业务 API，也不支持腾讯购买计费。

测试种子只生成自有低敏内容，需手动运行，不随启动自动创建。包含私有测试专家、核验技能和不访问外网的 stdio Echo 连接器：

```sh
npm run content:seed -- --version 1.1.0
```

再次发布更高版本可联调更新。Echo mcp.json 使用 `${PLUGIN_ROOT}/scripts/echo.mjs`，由原版展开包路径，不能依赖原版不会保留的相对 cwd。任何客户端缓存中的旧标题或摘要由原版管理，验收更新必须同时核对真实本地元数据/文件版本与下载记录。

内容备份必须使用 `npm run backup` 或完整保存 data；新备份 manifest v2 同时包含 SQLite、delivery.key 和快照引用的安装包/源文件。恢复保留内容版本与上下架状态，并让所有旧登录会话失效。仅复制数据库会丢失分发资源。

## 准备原版客户端配置

### 双击启动

现在也提供可放 Dock 的原生 `企业AI工作台.app`，已安装到用户 Applications，并配置当前用户登录任务。它复用同一品牌启动逻辑和数据目录；本地网关未运行时会先启动并等待就绪。点击 Dock 已运行入口会激活现有窗口。使用、构建和回退说明见工作区 `macos-launcher/README.md`。

工作区根目录已提供 `启动WorkBuddy.command` 和 `workbuddy-launcher.json`。先编辑 JSON 的 `gateway`，填写真实网关地址；默认沿用本地测试地址 `http://127.0.0.1:8787`。之后双击 `.command` 即可启动，不需要自己 export，也不需要客户端驻留代理。

`productName` 设置侧栏显示名称，`welcomeTitle` 设置首页标题；当前分别为 `企业AI工作台` 和 `企业AI工作台，我帮你`。不填写 `welcomeTitle` 时按 `${productName}，我帮你` 生成。两项只接受单行文本。原版 5.8.1 会重建产品配置，所以启动器在安装包外加入运行时文字覆盖：在原版入口执行前注册主窗口加载钩子，首次加载、React 重绘和界面刷新时自动校正两处文本，不改节点结构或旁边标签。完整退出后双击同一启动器即可生效，不用重新登录或手动重新加载。

运行时覆盖使用原版允许的随机 loopback Node Inspector 启动参数，安装钩子后恢复执行，立即关闭 Inspector，并确认端口拒绝连接才报告启动完成。启动辅助程序随后退出，不驻留代理，不处理认证凭据或模型请求；只匹配此安装包内的 `renderer/index.html`。临时启动文件以 0600 权限创建并清理，启动记录仅保存名称和已关闭的端口号。若钩子失败，只停止它刚创建的进程，不强制结束用户已有实例，也不留下成功记录。

已在 macOS 原版 WorkBuddy 5.8.1 验证连续两次完整重启、登录恢复和界面刷新。版本号、应用标识、登录回调、数据目录、账号及自定义模型文件保持原样。这是外部启动器的显示覆盖，未来 WorkBuddy 改动 Electron Fuse、入口或 DOM 后需重新验证。停用时删除启动 JSON 的 `productName` 与 `welcomeTitle` 并完整退出重开；若要一起回退后端发布的名称，再恢复后端品牌配置。详见工作区 `evidence/sidebar-brand-audit/automatic-start/README.md`。

后端仍支持数据目录 `product-branding.json` 或 `GATEWAY_PRODUCT_NAME`，通过原版 `/v2/feature-flag/api/product-config` 发布名称，复用现有认证且不提供模型定义。新的双击显示覆盖不依赖这次认证同步或企业首页配置。

```json
{
  "gateway": "https://auth.example.com",
  "appPath": "/Applications/WorkBuddy.app",
  "mode": "development",
  "nodeExecutable": "",
  "reuseDevelopmentAuth": false,
  "replaceProductionLogin": false
}
```

`nodeExecutable` 留空时，启动入口查找 PATH、Homebrew 和 `/usr/local/bin` 下的 Node.js 24；安装在 nvm 等其他位置时可填写完整路径。配置只作为 JSON 数据读取，不会被 source 或 eval 执行。

使用私有 CA 的 HTTPS 入口时，可在启动 JSON 中增加 `caCertificate`，填写公开 CA PEM 文件的相对路径或绝对路径，例如 `certs/workbuddy-private-ca.pem`。启动器校验证书的 CA 标记和有效期，通过 `NODE_EXTRA_CA_CERTS` 为原版主进程增加信任，并将 CA 合入外部 profile 的 `config/system-ca-bundle.pem`；原版后台会过滤继承的证书环境并优先读取该缓存。已有证书完整保留，自定义模型配置保持原样。浏览器登录还需要操作系统信任该 CA。macOS 可将公开 CA 导入当前用户钥匙串，SSL 信任限定到入口主机；系统认证弹窗由用户完成。CA 私钥和服务端私钥不分发到客户端，不使用关闭 TLS 校验的环境变量。

每次启动会读取当前 WorkBuddy 的内置产品配置，更新自己的 `client-profiles/double-click` 目录，将网关地址写入启动环境和外部产品配置。该目录的 `config/models.json` 保持不动；默认模型项被停用，远端配置加载关闭。WorkBuddy 的开发端点配置也同步为同一网关，防止已有 resolver 抢占 `WORKBUDDY_DEV_ENDPOINT_OVERRIDE`。新增 UseEnterpriseDownloadSource:true、DisableSkillHub:true、ConnectorMarketApiEnabled:false，并设置私有连接器 zip URL。该开关只改资源路由，不代表企业资格。旧来源缓存由原版同步，启动器不删除用户插件、任务或凭据；原版采用来源后可用 inspectConnectorCatalogSource(profile,{expectedSha256}) 核对 sourceKey、哈希及实际 manifest，不能把目录同步当作已连接。

连接器来源文件使用管理标记，只更新启动器拥有的 URL 字段。已有外来覆盖文件、被其他程序改过的管理字段或符号链接会报冲突并保留文件。SkillHub 正常入口关闭；推荐技能使用共享 `_skillhub_meta.json` 文件但 source 为 marketplace，原版会排除它们的 SkillHub 检查链。既有真正 SkillHub 安装仍需单独迁移，不能把关闭入口解释为全客户端网络封禁。

默认 development 使用 `workbuddy-desktop-dev.info`。首次启动若发现不属于此启动器的开发登录态，会停止，且不删除认证文件。确认可复用时将 `reuseDevelopmentAuth` 设为 true。此启动器成功启动过、且登录文件的 domain 与当前网关一致时，后续双击可自动复用。认证目录仍在系统用户级共享，不能把上述检查理解为独占认证存储。production 模式仍需显式设置 `replaceProductionLogin:true`。

如果 WorkBuddy 或后台进程仍在运行，脚本会要求先完整退出，不会杀进程或只激活旧实例。启动后启动器退出，可关闭终端窗口；模型请求按 WorkBuddy 内的自定义模型配置直连，脚本不监听端口。

仅检查和生成外部配置、不启动应用：

```sh
./启动WorkBuddy.command --check
```

首次保存 `.command` 后需保留执行权限；本工作区已经设置。可以为它建立 Finder 替身放在桌面，但不要单独搬走脚本而丢失同目录的 JSON 和 `auth-gateway` 文件夹。

### 命令行启动

macOS 示例：

```sh
npm run client:prepare -- \
  --app /Applications/WorkBuddy.app \
  --gateway http://127.0.0.1:8787 \
  --profile client-profiles/local
```

这个命令只读取发布包中的 `cli/product.json`，在新目录生成外部产品配置和 `launch.json`。它不启动、不修改 WorkBuddy 安装包。已为当前机器准备好 `client-profiles/local/launch.json`。

其他平台可传 `--product <发布包的product.json> --executable <WorkBuddy程序路径>`；默认 macOS 可执行文件名来自当前 5.8.0 安装产物，若版本不同，显式传 `--executable`。

生成的配置保留原认证 provider，通过 `WORKBUDDY_DEV_ENDPOINT_OVERRIDE` 指向网关。`config.disabled:true` 和 `CODEBUDDY_REMOTE_CONFIG_DISABLED=1` 关闭两条远端产品配置加载路径，同时停用产品实验轮询和额度 UI。网关的 `/v3/config` 只是兼容 metadata，没有任何模型定义。现有内置模型写为 `disabled:true`，自定义模型仍由客户端本地 loader 添加。

**认证文件的隔离与其他配置不同。** WorkBuddy 把认证文件写入系统用户共享的 `CodeBuddyExtension/Data/Public/auth`，仅改变 `WORKBUDDY_CONFIG_DIR` 不会隔离它。默认准备的是 development 模式，它利用原版已有的 `workbuddy-desktop-dev.info` 命名空间，避开生产 `workbuddy-desktop.info`。本机原版 5.8.1 已验证登录、重启恢复和会话撤销；这不代表生产环境的多用户存储隔离已验收。

启动前先关闭其他 WorkBuddy 实例并检查：

```sh
npm run client:launch -- --profile client-profiles/local/launch.json --check
npm run client:launch -- --profile client-profiles/local/launch.json
```

如果已存在 development 认证文件或退出 marker，启动器会停止；只有确认是自己的测试会话后才使用 `--reuse-development-auth`。生产模式建议在独立操作系统账号验证。若明确要替换当前系统账号的共享 WorkBuddy 登录，可重新准备 `--mode production` 的配置，并在启动时显式传 `--replace-production-login`；它不会自动替你备份或清理现有登录态。

## 配置和选择自定义模型

登录成功后打开 WorkBuddy 的模型设置，添加 OpenAI chat-completions 兼容模型，填写实际 model ID、绝对 URL 与模型服务 API key，然后在会话中明确选择该自定义模型。认证网关 token 和模型 API key 是不同凭证。模型服务地址应指向实际模型服务，而不是本认证网关。

配置结构示例见 `examples/models.example.json`。原始 `id` 使用服务接受的 model ID，不手工加 `custom-local:` 前缀；原版会自动加内部前缀并在请求前去掉。`useCustomProtocol:false` 会归一化/追加 `/chat/completions`，设为 true 只是 URL 原样使用，并不自动切换成其他厂商协议。

也可在生成 profile 的 `config/models.json` 使用示例结构，替换占位 ID 和地址；`${LOCAL_MODEL_API_KEY}` 可由实际启动进程的环境展开。模型设置页的连接探测使用表单里的实际 key，不能把这个环境占位符当成探测时的真实密钥。

disabled 内置项仍可能被原版保留在兼容快照中；全无可用 custom 时 CLI 还有默认模型 fallback。**先配置、选择可用 custom，再执行任务。** 网关对模型端点返回 501，不转发到腾讯。真实桌面的辅助任务、子代理、已保存的模型变体也应确认使用 custom；这里没有承诺阻断 WorkBuddy 所有网络访问。

## 关闭未提供的云服务入口

这些功能开关通过原版 `ACC_PRODUCT_CONFIG_PATH` 加载安装包外的产品配置生效；企业名称另使用上文说明的运行时显示钩子。开关集中在 `src/compatibility.mjs` 的 `LOCAL_FEATURES`；双击启动时重新生成 `client-profiles/double-click/product.local.json`，因此只手工修改生成文件不会在下一次启动后保留。

当前默认增加以下开关，针对原版 5.8.1 已核对调用链：

| 开关 | 行为 |
| --- | --- |
| `TencentNetDriveKnowledge:false` | 隐藏“云端网盘”标签，跳过该页的网盘 SDK 初始化，保留“本地产物” |
| `DisableCloudAssistantUpgradeBanner:true` 与 `DisableTeamsProject:true` | 两个开关同时关闭云端助理的权益探测；助理入口另由 Claw 控制 |
| `Claw:false` | 隐藏整个“助理”侧栏入口，包括本地助理；不代表已运行的消息通道或任务已被终止 |

旧客户端配置仍访问个人或项目网盘取 token 接口时，网关先验证登录，随后明确返回 HTTP 501、`NETDRIVE_DISABLED` 与“当前服务未启用云端网盘”。未登录或已撤销会话仍返回 401，数据库异常仍返回 500。不要把空 token 或未实现的上传接口包装成成功；原版会把 HTTP 200 空 token 当成成功初始化，并可能回退请求腾讯网盘。

2026-10-12 用原版 5.8.1 重启后实测：“我的文件”只显示“本地产物”，原有本地文件仍列出，进入该页没有网盘取 token 请求或截图中的两条 404 提示。安装包 ASAR、内置 product.json、自定义 models.json 的前后 SHA-256 相同。截图与验收记录在上层 `evidence/cloud-features-my-files.png`、`evidence/cloud-features-local-acceptance.json`。

这是具体功能的关闭策略，不能保证全部腾讯后台请求停止。例如网盘 MCP 连接器仍有独立请求，消息中心、市场、云端同步等也不属于本服务范围。其他原版开关如 `TencentDocsKnowledge:false`、`TencentLexiangKnowledge:false`、`ImaKnowledge:false` 可隐藏各自知识库入口；`Automation:false` 可隐藏定时任务入口，但会一并影响该功能。这些额外开关本次未启用，也未做实际界面验收。

当前个人通用工作台没有找到可用的外部配置链来隐藏整个“更多”菜单：其通用 baseline 来自发布包常量，服务端菜单覆盖也不是个人版的生效路径。不能把未经验证的 `HideMore` 等字段当成支持配置。具体证据见上层 `evidence/cloud-menu-audit/baseline-origin-notes.md`。

回退：移除新增的三个开关，正常退出后通过同一启动器重开；网盘入口会按原版配置恢复，但认证网关仍不提供网盘服务。回退配置不删除任务、账号、会话或模型配置。

## 协议与范围

| 接口 | 用途 |
|---|---|
| `POST /v2/plugin/auth/state?platform=workbuddy` | 返回 5 分钟有效的 state 和网页登录地址 |
| `GET /v2/plugin/auth/token?state=…` | 未完成时返回业务 code 11217，完成后一次性领取凭证 |
| `GET /v2/plugin/account` | 根据 Bearer token 返回本地个人账号，忽略伪造的用户/租户头 |
| `POST /v2/plugin/auth/token/refresh` | 按 X-Refresh-Token 旋转凭证，10 秒同结果重试窗口兼容 daemon/CLI 并行刷新 |
| `POST /v2/plugin/account/switch` | 只接受个人账号空请求，不提供企业切换 |
| `POST /v2/plugin/auth/logout` | 服务端撤销刷新会话 |
| `GET /v1/config`、`/v2/config`、`/v3/config` | 无模型的兼容 metadata |
| `GET /healthz` | 服务与数据库读取健康检查 |

返回账号不含 enterpriseId，原版会跳过企业模型列表和成员自定义模型策略接口。正常登录页具备 CSRF、origin 校验、持久化登录尝试限流及无缓存响应。可信代理使用精确 IP 白名单和 X-Real-IP，默认不信任转发头。日志只记录请求 ID、方法、路径和状态，不记录查询字符串、密码或 token。

原版默认 account-scoped provider 的 removeSession 是空实现，桌面退出不一定调用服务端 logout；因此本地退出不应解释为网关 refresh token 已立即撤销。服务端 TTL、停用账号与修改密码负责收敛会话。停用登录账号也不会吊销独立的模型服务 API key；模型权限由模型服务管理。

## 验证与部署边界

```sh
npm test
```

测试包含 HTTP 登录链、一次性轮询、刷新/并行重试、持久化恢复、退出、过期、停用、CSRF、限流、配置生成及原版认证 provider 与本地服务的兼容回放。回放测试引用 `test/fixtures/` 中未经改写的 5.8.0 provider 片段，使用替代 DI 和自动化网页登录；其他原版消费者片段同样随源码提交。完整测试不依赖工作区外的逆向记录。

2026-10-12 已用原版 WorkBuddy 5.8.1 实际验证真实账号密码登录、完整退出后恢复同一会话，以及服务端撤销后客户端提示登录失效；本机记录为上层 `evidence/local-real-client-acceptance.json`。测试使用 development 登录文件，不修改安装包。后续客户端内容、品牌、Dock 与本地模型验收见根 README 和对应组件说明；每个新部署仍需核对可信 HTTPS、客户端登录、工具调用及模型请求的实际目标。

本版本面向单机单进程部署，数据目录独占锁防止重复启动，SQLite 不是多节点共享会话数据库。部署脚本在升级和回滚前创建一致性备份，代码回滚保留数据库；恢复数据必须停服务，并让所有旧会话失效。还原客户端正常启动方式不会修改安装包，若曾替换生产共享登录，应重新按其原认证体系登录。

Node 加密 API 依据 [Node.js 24 crypto 文档](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。

## 本机运行数据

原工作区的本机 `http://127.0.0.1:8787` 已由真实后端替换 Mock，数据库使用 `data/`。既有测试凭据保存在本机 `local-test-credentials.json`（权限 0600、已加入忽略规则），没有默认密码，勿将此文件发布或提交。新检出不带账号库、登录态或凭据，请按上文创建自己的账号。

后端停止后，可以在 auth-gateway 目录重新运行 `npm start`；随后通过工作区启动器启动 WorkBuddy。Dock 应用也可从现有数据库启动本地后端。默认只监听 loopback。原版 SDK 的旧刷新请求在撤销测试中返回 401，界面显示“登录已失效”；这一认证测试没有发起模型任务。
