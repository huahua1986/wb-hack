# WorkBuddy 企业配置客户端：本地测试交付

此组件在原版安装包外准备认证入口、私有目录来源、功能开关和两处企业名称。安装后只固定原版 WorkBuddy 图标，不新建启动应用。登录任务直接运行附带 Node 和辅助脚本，运行时显示钩子安装完成后关闭 Inspector，脚本退出；不代理模型。

本版本为 macOS arm64 内部测试交付。支持的原版版本和文件哈希见 compatibility.json，目前验证 5.8.3。模型请求未在本轮重新压测。未知版本或文件变化会停止受控启动并提示联系管理员，不自动修改或降级 WorkBuddy。

## 用户安装

先安装官方 WorkBuddy，准备好可访问的认证后端。使用 ZIP 用户级测试包时：

1. 解压到任意普通目录，正常退出正在运行的 WorkBuddy。
2. 双击“安装企业配置.command”。首次打开本地浏览器设置页，填写实际网关，例如本机测试 http://127.0.0.1:8787。远程仅接受 HTTPS。等待安装窗口提示完成后再关闭终端。
3. 安装程序自动启动原版 WorkBuddy。新用户按客户端提示完成一次账号密码登录；后续有效会话自动恢复。模型在原版自定义模型配置中设置和选择。
4. 之后登录 macOS，登录任务预先完成受控启动；点击原版 Dock 图标打开窗口。

测试包会短暂显示安装用终端，不要求用户输入命令、安装 Node 或 Swift。当前用户的程序在 ~/Library/Application Support/EnterpriseWorkbenchClient/program，配置及 profile 在同级 state；登录任务为 ~/Library/LaunchAgents/local.workbuddy.enterprise-client.login.plist。移动或删除解压目录不影响安装后的程序。

地址可以重新配置：使用已安装运行时运行 client-distribution/bootstrap.mjs，传 --payload 指向 program，再传 --gateway 指定新入口。先完整退出 WorkBuddy；已有其他认证域的开发登录态时会拒绝自动接管，需要管理员完成认证迁移。程序不删除共享认证文件或旧账号。

设置页只在首次配置时监听本机 127.0.0.1 的随机端口，使用一次性链接、Cookie、CSRF 和来源校验；保存、取消或 5 分钟超时后关闭服务并删除临时文件。此页面不是账号管理后台，不处理用户名、密码或模型 Key。

本机 HTTP 仅用于已单独运行网关的测试。客户端不会创建账号数据库，也不会启动后端。每台电脑的 localhost 不是统一认证服务器；多电脑单会话限制需要共享同一个后端。新用户不接收账号库、交付密钥、登录态、API Key、模型权重或开发工作区。

## 冷启动边界

登录任务准备完成后，原版图标激活已注入实例。**完整退出后直接点击原版图标仍会绕过脚本**，这没有通过后台强制重启来掩盖，也不保证 macOS 恢复窗口或厂商自更新重启经过受控入口。需要重新应用时，可重新运行安装入口，或手动调用已安装 bootstrap；它不会终止用户已有任务。

系统启动时若原版已经由其他入口运行，组件提示正常退出再重试，不杀进程。版本变化需要先完成新版本验收并更新客户端交付包。关闭窗口不一定等于退出，行为以原版为准。

## PKG 与企业分发

同批构建同时输出系统级 PKG，将只读客户端代码放在 /Library/Application Support/EnterpriseWorkbenchClient，并安装 /Library/LaunchAgents 下的登录任务，供各用户使用独立 state。需要正常的 macOS 安装授权；无当前图形用户时在下次登录启用。

不要同时部署 ZIP 用户级入口和系统级 PKG。测试机推荐 ZIP，企业受管安装可选择 PKG。系统级安装目前需要额外的干净机器及安装授权验收，不以 ZIP 验证代替系统安装验收。

构建未提供 Developer ID 时，产物标为 internal-test。辅助程序仅临时签名，PKG 未签名、未公证，不作为公网上的正式安装包。不会关闭 Gatekeeper、TLS 检查或自动安装证书信任。若 macOS 阻止测试包，交给管理员正常签名和部署，不要求用户绕过安全警告。

远端使用私有 CA 时，可在构建时附公开 CA，Node 和原版后台增加信任；浏览器仍需系统信任，由用户或企业管理策略完成。包不包含 CA 私钥，也不自动改系统钥匙串。正式交付应提供可信 HTTPS 和签名、公证或企业受管部署。

## 构建

在开发机准备官方 Node 24+ macOS arm64 解压目录，先核对官方 SHA-256。本机系统 Node 的签名若无效，构建程序会拒绝使用；无需修改系统 Node。

    node scripts/client-distribution/build.mjs --node-dir /path/to/node-v24.21.0-darwin-arm64

默认网关为空，在首次启用时设置。IT 可传 --gateway 预置地址，--ca 附公开 CA，--models 附模型 JSON（只允许空 key 或环境变量占位符，拒绝实际 API Key）。已有 models.json 完整保留，不由安装包覆盖。不要把个人 models.json 直接当作交付模板。

可通过 --application-signing-identity 和 --installer-signing-identity 签名；--require-signed 要求两者齐备。签名成功仍不等于公证，需另行用 Apple 正式流程提交公证并验证票据。build-report.json 区分 internal-test 与 signed-not-notarized。

构建输出在 dist/client-distribution，包括 PKG、ZIP、SHA-256 和仅含客户端的 payload。清单只列必要源码、原生辅助程序、官方运行时及许可证；不包含原版 WorkBuddy。

## 现有测试工作区迁移

新用户无需迁移。已有本项目测试 profile 的机器，可在完整退出 WorkBuddy 后，用解压包的附带 Node 调用 install.mjs，加 --migrate-from 指向旧工作区，并用 --gateway 明确指定同一个网关。只接受本项目拥有、网关与认证模式一致的 profile，复制到新用户目录，保留原目录和模型定义。使用 APFS clone 减少复制成本；profile 较大时仍需等待。

这是显式本机迁移，不会把 profile 写进交付包。安装后备份并停用本项目旧的“企业AI工作台.app”登录任务、替换其固定 Dock 图标；已退出的旧启动应用归档到 state/legacy-launcher.app，旧工作区保留。其他登录项、固定图标和生产认证文件不变。若旧启动应用仍运行，暂不移动它，正常退出后下一次受控启动再归档。

## 停用与恢复

双击解压包中的“停用企业配置（保留数据）.command”，或使用已安装运行时运行 program/client-distribution/uninstall.mjs，可停用用户级登录任务，保留账号相关状态、模型、任务和程序文件。旧托管启动应用和登录任务备份存在时恢复原位置，下次登录生效；遇到其他应用占用原位置则保留备份，不覆盖。原版 Dock 图标保留。

系统级 PKG 的文件和全局登录任务需管理员移除，用户状态不随之删除。卸载后，已经运行的进程中的文字覆盖直到退出才消失；通过原版正常启动恢复原行为。升级程序保留 previous 目录供恢复，不自动清理用户文件。

## 本轮验证

本轮验收：93 项测试通过；WorkBuddy 5.8.3 实机完成浏览器地址设置、用户级安装与迁移、停用回退和重装、移开解压源目录后的登录任务冷启动；账号和自定义模型保留，单会话计数为 1。独立读取系统 Dock 验证仅固定原版图标，其他项目顺序不变。原版文件与模型定义哈希一致，Inspector 已关闭。现场记录在工作区 evidence/client-delivery/，不进入 Git。未实际重启电脑、未安装系统级 PKG、未使用干净新机器；不把这些待验项算作通过。
