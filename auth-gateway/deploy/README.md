# WorkBuddy 私有认证与内容后端部署

支持 Linux、systemd、Nginx、Node.js 24+，单机单进程 SQLite。账号、会话、内容目录和审计通过 SSH/服务器终端管理；浏览器提供真实账号密码登录。0.3.0 增加私有内容分发，0.3.1 增加单账号单会话，客户端认证协议保持兼容，模型 URL 和 API Key 独立配置。

## 构建交付包

在开发工作区运行：

```sh
cd auth-gateway
npm test
npm run package
```

输出 `dist/workbuddy-auth-0.3.2-<内容哈希>.tar.gz` 和相邻 `.sha256`。发布包只包含后端代码、管理命令、部署脚本、文档和独立后端测试，不包含数据库、密钥、Mock、客户端 profile、模型 Key、逆向证据或 WorkBuddy 安装包。原版 provider 回放和启动器测试在开发工作区执行。校验文件可检出修改/损坏，不能替代可信来源或数字签名。

## 首次部署

目标建议使用 Debian/Ubuntu 的 systemd 主机，预装 Node.js 24+、Nginx、Bash、tar、useradd、runuser 和 flock，并运行 systemd 和 Nginx 服务。准备正式 HTTPS 域名、DNS 和有效证书。脚本不下载运行时、不申请证书、不修改防火墙；Nginx 必须预先启动，安装只在验证配置后 reload。

```sh
sha256sum -c workbuddy-auth-0.3.2-<内容哈希>.tar.gz.sha256
tar -xzf workbuddy-auth-0.3.2-<内容哈希>.tar.gz
cd workbuddy-auth
node deploy/verify-package.mjs
sudo bash deploy/install.sh \
  --origin https://auth.example.com \
  --tls-cert /etc/ssl/auth.example.com/fullchain.pem \
  --tls-key /etc/ssl/auth.example.com/privkey.pem \
  --node /usr/bin/node
```

替换域名和证书路径。外部 HTTPS 端口为 443，后端仅监听 `127.0.0.1:8787`。Node 必须安装在受服务保护策略允许的系统目录，不能放在 `/root`、`/home`。可配置 `--prefix`、`--data-dir`、`--config-dir`、`--port`、`--service-user`；路径必须绝对且无空格、路径穿越或 shell 字符，服务用户非 root 且主组同名。

先检查生成结果而不安装：

```sh
bash deploy/install.sh \
  --origin https://auth.example.com \
  --tls-cert /etc/ssl/auth.example.com/fullchain.pem \
  --tls-key /etc/ssl/auth.example.com/privkey.pem \
  --node /usr/bin/node \
  --render-only /tmp/workbuddy-auth-plan
```

输出目录必须为空。此模式只写该目录，不创建系统账号、不启停服务、不改 Nginx。

| 默认位置 | 用途 |
|---|---|
| `/opt/workbuddy-auth/releases/<ID>` | root 管理的程序版本 |
| `/opt/workbuddy-auth/current` | 当前版本链接 |
| `/opt/workbuddy-auth/deployment.json` | 部署记录 |
| `/etc/workbuddy-auth/gateway.env` | root 写、服务账号可读的配置 |
| `/var/lib/workbuddy-auth` | 私有数据库、密钥与进程锁 |
| `/var/lib/workbuddy-auth-backups` | 私有备份 |
| `/etc/systemd/system/workbuddy-auth.service` | 服务托管 |
| `/etc/nginx/conf.d/workbuddy-auth.conf` | HTTPS 入口 |
| `/usr/local/bin/workbuddy-auth` | 管理命令 |

安装拒绝覆盖非托管程序、服务与配置，也拒绝自动接管已有非空数据目录。首次部署无默认账号。现有 `gateway.env` 在升级时保留，域名、数据目录与监听地址必须匹配请求的部署。失败时恢复此前代码链接和配置，保留数据与失败版本。脚本不自动清理旧 release。

## 账号、会话与审计

```sh
sudo workbuddy-auth user add feiz --display-name feiz
sudo workbuddy-auth user list
sudo workbuddy-auth user set-password feiz
sudo workbuddy-auth user set-display-name feiz --display-name 新名称
sudo workbuddy-auth user disable feiz
sudo workbuddy-auth user enable feiz
sudo workbuddy-auth user unlock feiz
sudo workbuddy-auth session list feiz
sudo workbuddy-auth session list feiz --all
sudo workbuddy-auth session revoke feiz --id <会话ID>
sudo workbuddy-auth session revoke feiz --all
sudo workbuddy-auth audit --username feiz --limit 100
```

密码在终端隐藏输入并确认，不放在命令行。至少 15 个 Unicode 字符、最多 1024 UTF-8 字节，拒绝少量明显弱口令；内置名单不是完整泄漏密码库。新记录使用 scrypt N=32768、r=8、p=3，旧 p=1 记录仍可验证，应通过重置密码升级。参数参考 [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，计算耗时与并发仍需在目标服务器评估。

停用、重置密码、会话撤销立即阻止账号查询与刷新，也阻止领取已绑定的未交付会话。重新启用不恢复旧会话，修改显示名称保留会话。会话列表不返回 token 或哈希。解锁只清除该账号登录尝试计数，来源 IP 保护仍有效。WorkBuddy 客户端退出不一定通知后端，因此不等于服务端撤销。

0.3.1 默认拒绝已有有效会话账号的新登录。升级启动会保留旧库中最近使用的一条会话，撤销同账号的其他会话并记录审计，安装脚本会先备份。用上面的 session revoke 命令释放名额后即可重新登录；关闭客户端不会自动释放。所有电脑必须连接同一个后端。详情见 [单会话说明](../README.md#单账号单会话与管理员释放)。回滚旧代码会恢复旧的多会话签发行为，已撤销的会话不会恢复。

公网不开放管理 API。服务器管理权限由 sudo/root 控制，账号操作降权到服务账号，原 sudo 用户记录为操作人。审计包含账号、操作人、会话 ID 和登录来源 IP，默认保留 90 天，可配置 `GATEWAY_AUDIT_RETENTION_DAYS`；它不是抵御 root 篡改的不可变日志。限流计数保存在 SQLite，重启后仍有效。

## 客户端与模型

在原客户端工作区 `workbuddy-launcher.json` 中把 `gateway` 改为正式 HTTPS 地址，完整退出 WorkBuddy 后双击启动器，再通过新后端登录。启动器同时设置 `WORKBUDDY_DEV_ENDPOINT_OVERRIDE` 和外部配置，不修改安装包。

切换域名时，开发登录文件仍为系统用户级共享。发现不属于新网关的已有开发登录态，启动器会停止；仅在确认是本轮可替换测试登录态后设置 `reuseDevelopmentAuth:true`，再启动并重新登录。该设置不把旧 token 变为正式凭证。Mock 数据目录不能作为正式账号库。

模型设置继续填写自定义 ID、绝对 URL 和模型 API Key，并在任务中选择它。认证后端仅返回兼容 metadata，模型端点返回 501。停用登录账号不会撤销独立模型 Key，模型服务需自行管理权限。辅助模型、子代理、工具调用和默认 fallback 要以实际任务验收。腾讯会话同步、连接器和调度等 SaaS 功能不在本后端范围内。

## 运行、升级与回滚

```sh
sudo workbuddy-auth health
sudo workbuddy-auth status
sudo workbuddy-auth logs -n 100
sudo workbuddy-auth backup
```

服务使用独立非 root 账号、只读程序目录和私有数据目录，可写范围限于数据及备份。日志记录请求 ID、路径、状态和耗时，省略查询参数与请求体。Nginx access log 使用 `$uri`，不使用 `$request`/`$request_uri`；代理错误日志应限制管理员访问和保留时间，避免对外分享原始登录 URL。监控服务不可用、持续 5xx/429、磁盘空间、证书过期和备份失败。

Nginx 覆盖 `X-Real-IP`，后端只信任 `GATEWAY_TRUSTED_PROXY_IPS` 的精确 IP；生成值为 `127.0.0.1,::1`，不接受 `*` 或 CIDR。若 Nginx 前还有 LB，先在 Nginx 限定可信上游，不能直接信任客户端转发头。

升级时把新包解压到另一目录，用相同参数运行它的 `deploy/install.sh`。脚本停旧服务并备份后切换代码。代码回滚保留数据库，只允许支持 schema 2 的 0.2.x 或 0.3.x 正式 release：

```sh
sudo workbuddy-auth rollback --dry-run
sudo workbuddy-auth rollback
sudo workbuddy-auth rollback --release <0.2.x或0.3.x-内容哈希>
```

回滚前同样备份，目标无法启动时恢复原代码。0.1.0 原型不能验证新 p=3 密码，不作为正式回滚目标。配置修改需重启并复验入口。本版本不支持多实例共享 SQLite；扩容需迁移共享数据库与限流实现。

## 内容目录管理

发布 manifest 与源文件放在服务账号可读的独立目录；sourceDir 必须相对于 manifest，不能指向账号数据目录、其父级或子目录。源文件夹不会被服务执行，发布后只保存不可变包和源对象。

```sh
sudo workbuddy-auth catalog publish --manifest /srv/private-content/manifest.json
sudo workbuddy-auth catalog list expert
sudo workbuddy-auth catalog show skill team-checklist --version 1.0.0
sudo workbuddy-auth catalog disable connector private-echo
sudo workbuddy-auth catalog enable connector private-echo
```

完整清单格式和包布局见主 README。受限专家/技能目录与下载复用原账号和会话，签名链接会在会话撤销后失效。原版静态连接器整包不带 Bearer，只有明确标记 public 且无账号 ACL 的记录入包；应使用符合内容可见范围的内网入口。第三方授权与模型访问仍由对应服务负责。

## 备份恢复

`backup` 通过 SQLite backup API 在线生成一致性快照，复制固定 delivery.key，并按该快照引用的 catalog_assets 保存内容对象，输出带完整校验清单的 manifest v2；默认输出 `<data-dir>-backups/<时间和随机ID>`。备份含密码哈希、交付密钥和私有内容，应按账号数据库同等级保护。丢失 key 时服务拒绝为已有数据库生成新 key。旧 v1 纯认证备份仍可恢复；包含内容引用却缺少资源的备份会拒绝恢复。

```sh
sudo workbuddy-auth backup --output /var/lib/workbuddy-auth-backups/manual-20261012
sudo workbuddy-auth restore /var/lib/workbuddy-auth-backups/<备份ID> --confirm-restore
```

恢复需要 root。命令停服务、校验文件与 SQLite 完整性，在临时目录清空备份中的全部会话和登录交付，再替换数据目录并启动。所有用户重新登录。恢复前的数据保留在 `*.before-restore-*`；失败不删除原数据。账号状态和密码回到备份时间点，必要时重新停用或重置。只恢复可信备份。

本版本安装器配置每日备份 timer，具体时间见下文；保留策略、异机复制和故障通知由运维配置，脚本不自动清理旧数据或上传账号库。`gateway.env`、证书和部署记录另行备份。备份失败应报警，定期在隔离目录演练恢复。

## 验收

测试覆盖真实 HTTP 登录、账号管理、会话撤销、CSRF、代理防伪造、限流持久化、原型 schema 与旧密码迁移、备份损坏检测、恢复强制失效、发布包启动和数据目录独占。发布包内可运行 `npm test`，不会操作 WorkBuddy。

目标主机仍需确认 systemd/Nginx 实际运行、DNS/证书、正式账号在 WorkBuddy 中登录及重启刷新，以及一次真实自定义模型和工具调用。发布包验证不能替代这些现场验收。


## 同机独立客户实例与定时备份

在现有测试实例旁新增客户实例，使用 `--instance customer`。默认派生独立的 systemd 服务、非 root 服务账号、程序/配置/数据/备份目录、管理命令与 Nginx 日志；不会复用原实例的账号库或 delivery.key。HTTPS 支持 443 或 1024 以上端口，反向代理保留包含端口的 Host。不同实例必须选择不同的后端监听端口，以及不冲突的 HTTPS 入口。

```sh
sudo bash deploy/install.sh \
  --instance customer \
  --origin https://auth.example.com:8443 \
  --port 8788 \
  --tls-cert /etc/ssl/auth/fullchain.pem \
  --tls-key /etc/ssl/auth/privkey.pem \
  --node /usr/bin/node
sudo workbuddy-auth-customer user add customer-demo --display-name 客户验证账号
sudo workbuddy-auth-customer session list customer-demo
sudo workbuddy-auth-customer session revoke customer-demo --all
```

客户实例使用 `/opt/workbuddy-auth-customer`、`/etc/workbuddy-auth-customer`、`/var/lib/workbuddy-auth-customer` 和 `workbuddy-auth-customer.service`。管理命令中的 status、logs、restore、rollback 也仅作用于该实例。旧部署记录未提供 service 字段时继续识别为原默认实例。

每次部署会安装并启用该实例的 `*-backup.timer`：服务器本地时间每日 03:15，加最多 10 分钟随机延迟，停机漏跑后补执行。备份使用 SQLite 一致性快照，并包含交付密钥及被引用的私有内容资源。首次部署后应主动运行并检查一次：

```sh
sudo systemctl start workbuddy-auth-customer-backup.service
sudo systemctl show workbuddy-auth-customer-backup.service -p Result -p ExecMainStatus
sudo systemctl list-timers workbuddy-auth-customer-backup.timer
```

定时备份保存在实例数据目录同级的 `-backups`，权限受独立服务账号限制。不会自动删除旧备份；保留周期、磁盘监控、异机复制及故障通知由运维设置。同机备份不能抵御整机或磁盘损坏。新入口还需客户网络、云安全组及证书信任验收，脚本不会修改防火墙或关闭 TLS 检查。私有 CA 可以只分发公开证书，CA 私钥留在服务端。
