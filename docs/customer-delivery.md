# 客户独立实例交付

2026-10-17 在现有服务器旁新增独立客户实例。原测试实例保留在 `https://21.130.240.28`，客户入口为 `https://21.130.240.28:8443`。客户网络必须能访问该入口；无可达路由的隔离网应在内网重新部署，不能把当前地址视作天然可达。

| 项目 | 客户实例 |
|---|---|
| 后端版本 | 0.3.2，发布清单含内容哈希 |
| HTTPS / 后端监听 | 8443 / 127.0.0.1:8788 |
| systemd / 管理命令 | workbuddy-auth-customer / sudo workbuddy-auth-customer |
| 程序、配置、数据 | /opt/workbuddy-auth-customer、/etc/workbuddy-auth-customer、/var/lib/workbuddy-auth-customer |
| 备份 | /var/lib/workbuddy-auth-customer-backups |
| 服务账号 | workbuddy-auth-customer，独立非 root 账号 |
| 会话策略 | 已有有效会话时拒绝新登录，管理员释放后可重新登录 |

客户数据库、会话、delivery.key、内容目录及 TLS 私钥均独立创建，不复制测试实例数据。当前客户内容目录为空，按实际需要发布专家、技能、连接器。账号管理通过服务器命令行进行，没有独立 Web 管理后台。

## 部署与重建

后端发布包在开发机使用 Node.js 24+ 构建，无第三方依赖：

```sh
cd auth-gateway
npm test
npm run package
```

输出 `dist/workbuddy-auth-0.3.2-<内容哈希>.tar.gz` 及 `.sha256`，发布 ID 以构建输出为准。本次现场部署 ID 为 `0.3.2-d3d6561254bd`；后续代码或随包文档变化会产生不同内容哈希。

目标 Linux 主机需预先准备 Node.js 24+、systemd、Nginx 和受信任的 HTTPS 证书。上传并校验发布包，解压后运行 `node deploy/verify-package.mjs`。本次客户实例使用以下参数；换主机时替换入口、证书及 Node 路径：

```sh
sudo bash deploy/install.sh \
  --instance customer \
  --origin https://21.130.240.28:8443 \
  --port 8788 \
  --tls-cert /etc/workbuddy-auth-customer-pki/fullchain.pem \
  --tls-key /etc/workbuddy-auth-customer-pki/server.key \
  --node /opt/workbuddy-runtime/node-v24.21.0-linux-x64/bin/node
```

安装器不生成证书、不修改防火墙。升级必须继续使用相同实例名、入口、端口及目录，避免误操作原测试实例。可追加 `--render-only /tmp/customer-deploy-plan` 在空目录预览生成的服务、备份任务、代理配置和管理命令。完整参数及恢复行为见 [后端部署说明](../auth-gateway/deploy/README.md)。

客户端在 macOS arm64 构建机准备已核对官方 SHA-256 的 Node 24 arm64 解压目录，以及该服务器的公开 CA：

```sh
node scripts/client-distribution/build.mjs \
  --node-dir /path/to/node-v24.21.0-darwin-arm64 \
  --output dist/customer-client \
  --gateway https://21.130.240.28:8443 \
  --ca /path/to/public-ca.pem \
  --models client-distribution/models.local.example.json
```

此命令在仓库根目录执行，输出目录必须尚不存在。客户端附带 Node 运行时及许可证，不要求终端用户单独安装 Node。模型预置只允许空 API Key 或环境变量占位符，不能使用个人真实配置文件打包。签名参数、PKG 和公开 CA 校验方法见 [客户端构建说明](../client-distribution/README.md#构建)。

## 交付文件与信息

| 交付项 | 内容与使用者 |
|---|---|
| 客户端 ZIP 与 SHA-256 | 终端用户安装；已预置客户地址和公开 CA |
| 系统级 PKG 与 SHA-256 | 可选受管安装方式，本轮未实际安装验收 |
| 后端 tar.gz 与 SHA-256 | 运维部署、升级；不包含账号数据或运行密钥 |
| 公开 CA 与证书指纹 | IT 配置信任，不分发 CA 或服务器私钥 |
| 部署运维说明、离线验收说明、验收记录、校验清单 | 使用步骤、已验证范围、待验事项及文件完整性 |
| 原版 WorkBuddy、模型运行时与模型权重 | 另行准备；本项目交付包不包含这些软件和权重 |

本机产物目录是 `dist/customer-21.130.240.28-0.3.2/`，汇总包为 `dist/WorkBuddy客户交付-0.3.2-21.130.240.28.zip`。它们是本批构建输出，不随 Git 克隆或 GitHub 推送提供。账号密码、SSH 私钥、数据库、登录态、客户配置、原始日志和现场截图均不进入源码提交；可共享的验收结论已写入本文，交付包内仅包含脱敏验收记录。

客户需确认终端系统与架构、认证入口可达性和 CA 信任、服务器资源与存储、实际模型地址和模型 ID、独立模型认证、账号清单及会话释放负责人、待发布内容与离线依赖。初始凭据通过独立安全渠道提供，验收速度以客户目标硬件和任务为准。

## 客户端安装

本批客户端 0.1.2 仅验证 macOS Apple Silicon、原版 WorkBuddy 5.8.3。ZIP 预置客户地址、公开 CA 和空模型密钥的本机 Ollama 模板。它不包含官方 WorkBuddy、账号库、密码、登录态、模型权重或私钥。

1. 安装指定官方版本，并准备本机或内网模型服务。
2. 由 IT 将公开 CA 正常加入系统信任，核对 SHA-256 指纹。客户端不会自动改变系统钥匙串，不关闭 TLS 校验。
3. 正常退出 WorkBuddy，解压 ZIP，双击“安装企业配置.command”。
4. 新用户使用管理员分配的账号密码完成一次网页登录。原版图标完整退出再打开会自动应用企业名称和客户后端，有效会话自动恢复。
5. 首次登录后在模型下拉框选择自定义模型，例如 qwen3.8:27b；“快速/均衡/极致”不由此后端提供推理。确认实际模型 URL、模型 ID 和独立模型认证。共享模型服务应替换 localhost；现有 models.json 不会被安装包覆盖。

账号初始密码单独安全交付，不写进通用包。customer-demo 仅作为本轮验证账号，交客户前按其账号清单新增账号或重设验证账号密码。验收专用 customer-acceptance 完成测试后停用。多个客户需要分别建立实例，不能以这一个客户实例承诺租户隔离。

ZIP 是当前实际验证的用户级安装方式。PKG 是系统级备选，不能与 ZIP 同时部署，尚需实际安装验收。当前产物为 internal-test，未正式签名、公证；受管试点之外的正式分发需完成相应签名或企业管理部署。

## 运维

```sh
sudo workbuddy-auth-customer health
sudo workbuddy-auth-customer status
sudo workbuddy-auth-customer user list
sudo workbuddy-auth-customer user add <用户名> --display-name <显示名>
sudo workbuddy-auth-customer user set-password <用户名>
sudo workbuddy-auth-customer session list <用户名>
sudo workbuddy-auth-customer session revoke <用户名> --all
sudo workbuddy-auth-customer catalog publish --manifest /srv/customer-content/manifest.json
sudo workbuddy-auth-customer logs -n 100
sudo workbuddy-auth-customer backup
sudo systemctl list-timers workbuddy-auth-customer-backup.timer
```

每天服务器本地时间 03:15 加 0–10 分钟随机延迟执行一致性备份，停机漏跑后补执行。首次备份任务已手动执行成功并核对文件校验。备份包含密码哈希、交付密钥和私有内容，权限与数据库同等级保护；当前保留全部备份，不自动删除。同机备份不覆盖整机损坏，异机复制、保留期限、磁盘与证书监控需交接运维。

恢复命令为 `sudo workbuddy-auth-customer restore <备份目录> --confirm-restore`，会停止客户服务并使客户旧会话全部失效；不要对测试实例执行客户恢复。代码回滚通过 `sudo workbuddy-auth-customer rollback --dry-run` 先检查，仅在客户实例有历史 release 时可用。首次部署若需撤回，停止并禁用客户服务和客户备份 timer，移除客户 Nginx 配置并在 nginx -t 成功后 reload；保留数据、备份和发布目录，不移除原测试实例文件。

## 验收边界

本机全量测试 114/114、目标 Linux 发布包测试 37/37 通过。真实 HTTPS 已验证账号密码登录、第二次登录 409、客户服务重启后查询与刷新、管理员释放后旧 access/refresh 401，以及释放后重新登录。客户凭证不能访问原测试实例。原测试实例的进程、配置、交付密钥和发布路径保持不变。

已在原版 WorkBuddy 5.8.3 完成客户账号登录和完整退出后原入口重开；客户账号、两处企业名称及选定的 qwen3.8:27b 自动恢复，客户服务账号查询和刷新返回 200，有效会话保持 1。新客户账号使用独立任务空间，原本机账号的 profile 数据保留，迁移前配置和认证已私有备份，不把旧登录态复制进交付包。原版客户端已实际直连本机 Ollama 并完整回复“客户后端与本地模型直连正常。”，界面耗时 7m13s，其中 30,580 token 输入处理约 364.8 秒；这不是认证耗时或客户硬件容量承诺。部分未实现的云接口仍返回 404，不代表腾讯云 SaaS 全功能兼容。完整结果见随批交付的验收记录。客户现场仍需复验真实网络隔离、DNS/HTTPS、整机重启、干净新电脑、目标硬件模型速度和工具依赖。认证及内容后端不代理模型请求，也不能撤销独立模型服务的 API Key。停用认证账号不能作为本地模型的强制停用机制。
