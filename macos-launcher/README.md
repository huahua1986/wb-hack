# 企业AI工作台 Dock 与登录启动应用

下文“已安装”和验收结果指原工作区本机；Git 保存源代码和构建脚本，不包含生成的应用或现场记录。新检出先按根 README 创建后端账号，再构建安装。

已安装：`~/Applications/企业AI工作台.app`。Dock 中原有 WorkBuddy 固定入口已替换为此应用，其他固定图标不变。原版仍安装在 `/Applications/WorkBuddy.app`，文件未修改。

登录任务：`~/Library/LaunchAgents/local.workbuddy.enterprise-ai-launcher.login.plist`。RunAtLoad=true，KeepAlive=false，调用 `/usr/bin/open -a 企业AI工作台.app --args --autostart`。它在当前用户登录图形桌面时执行，不是系统级后台守护进程。系统设置中已确认原版 WorkBuddy 不在“登录时打开”列表；其他登录项与受管理后台项目保持原样。

## 使用

点击 Dock 中的“企”图标，或打开用户 Applications 中的企业AI工作台.app。启动应用调用已有品牌启动代码，自动显示侧栏和首页名称。配置仍使用本项目的 `workbuddy-launcher.json`；账号、会话、模型、任务与安装内容继续使用现有目录，不复制到应用包里。

如果配置指向 `http://127.0.0.1` 的本地网关，启动应用先检查网关健康状态。网关未运行时，从现有 `auth-gateway/data` 启动后端并等待就绪；缺少账号库或 delivery.key 时拒绝创建空库。远程网关不自动启动本地后端。后台日志在 `auth-gateway/logs/desktop-backend.log`。

应用只在首次启动时调用辅助脚本，之后点击 Dock 图标直接激活正在运行的工作台。原版 WorkBuddy 退出后，此启动应用也退出。它没有 HTTP 代理或持续轮询模型的服务。

已有工作台必须匹配启动记录的 PID、进程启动时间、网关、模式及品牌配置，才会作为已有实例复用。其他入口启动的实例会提示正常退出，不强制停止用户任务。

## 验证

- 从安装好的应用启动原版 WorkBuddy，自动恢复测试账号、Ollama qwen3.8:27b 和两处企业名称。
- 正常退出工作台并正常停止本地网关，再触发真实登录任务：后端与原版工作台均自动恢复，名称正确，无手动登录。对应系统任务退出码 0。
- Dock 仅有一个企业固定入口，原版 WorkBuddy 固定入口为 0，其他原有图标保持原顺序。原条目备份在 `evidence/dock-launcher/dock-original-tile.plist`。
- 全套后端测试 76 项通过。安装包 ASAR、可执行文件、内置产品配置及模型文件前后哈希一致。
- 未实际重启电脑；验证的是已启用的登录任务及其完整冷启动路径。macOS 的“重新打开上次窗口”、原版自更新重启等其他系统恢复路径没有在本次验收中测试。

## 构建和安装

在项目根目录使用 Node.js 24+，本机需 Apple Swift 编译工具：

```sh
node scripts/macos-launcher/build.mjs
node scripts/macos-launcher/install.mjs
```

构建输出为 `dist/macos-launcher/企业AI工作台.app` 和 Dock 配置工具。安装脚本只覆盖带本项目所有权标记的启动应用，会拒绝覆盖其他应用，更新前需退出正在运行的启动应用。安装使用当前用户目录和当前工作区路径，不要求修改原版包。此版本为本机 arm64 应用、临时签名，未做发行公证。

启动应用的 Resources/launcher.json 保存现有工作区位置；移动工作区后需重新构建安装。Node 路径继续读取启动配置里的 nodeExecutable，或使用系统 PATH/Homebrew Node。

## 停用和回退

可在系统设置关闭“企业AI工作台”的后台活动，或卸载其用户 LaunchAgent。正常退出启动应用后移除用户 Applications 中的该应用。需要恢复原版 Dock 入口时，可从 `/Applications/WorkBuddy.app` 重新添加；备份记录仅包含原 WorkBuddy 图标，不覆盖其他 Dock 修改。

这些操作不删除账号库、密钥、会话、任务或模型文件。原有 `.command` 启动方式继续可用。
