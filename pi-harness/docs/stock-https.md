# 原版 WorkBuddy 通过 HTTPS 使用远端 Pi

WorkBuddy 外挂以 HTTPS 发送 Pi RPC 命令，以 SSE 接收模型增量、工具事件和运行终态。服务器内部保留 Pi 的 JSONL 子进程接口。SSE 中断后客户端用最后收到的事件 ID 重新订阅，停止按钮使用独立的取消请求。

服务器在独立的系统服务下运行，通过现有 Nginx 的 `/v1/pi/` 路由对外提供服务。客户端配置使用应用令牌和可信 CA，SSH 仅用于部署维护。服务端保存令牌哈希，按应用账号和线程 ID 隔离会话文件。

在配置中使用以下字段。另需填写本机 `cwd`、`stateDir` 和 `agentDir`。文本与 Office 模式各用独立的状态目录。现有 SSH 会话继续由原配置启动。

```json
{
  "https": {
    "url": "https://21.130.240.28",
    "tokenFile": "/absolute/path/to/private-token",
    "caFile": "/absolute/path/to/ca.pem",
    "mode": "text"
  },
  "provider": "tokenlink",
  "model": "hy4"
}
```

文本模式在原版 WorkBuddy 中选择「Pi 外部」后即可对话。

在 Office 配置中把 `mode` 改为 `fileOffice`，再用顶层 `officeDocuments` 列出 `cwd` 内要处理的 DOCX 文件名。每轮发送前，外挂校验并上传选定文件，同名同内容的文件可在该线程复用。每个文件上限 8 MiB。远端 Pi 加载固定版本的 `@mammothb/pi-office@0.2.1` 读取文档，另由受限工具生成精确替换文字后的 DOCX 副本。支持单个 Word 文本片段内的唯一匹配。处理完成后，外挂校验 SHA-256，把产物下载到本机 `cwd/Pi产物/<threadId>/`，并显示在会话产物列表。

使用以下命令启动原版 5.11.3。请将配置路径替换为本机实际配置。

```sh
node pi-harness/scripts/launch-stock-ssh.mjs /Applications/WorkBuddy.app /absolute/path/to/https-config.json
```

部署脚本为 `scripts/deploy-pi-https.sh` 和 `scripts/enable-pi-https-office.sh`，依赖服务器已有的 Node 24、Pi、TokenLink 配置和 WorkBuddy 443 虚拟主机。Office 扩展及依赖由 `remote-office/package-lock.json` 锁定。

`deploy-pi-https.sh` 接收待部署的 `pi-harness` 目录和客户端应用令牌的 SHA-256 摘要，创建独立的 `workbuddy-pi-https` systemd 服务和 Nginx 路由。`enable-pi-https-office.sh` 接收待部署目录，安装锁定的 Office 依赖并启用文件处理，启动检查失败时恢复配置、服务端和启动器。部署脚本针对现有服务器布局，分别在首次安装与首次启用 Office 时使用。客户端令牌文件、TokenLink 凭据、TLS 私钥和会话数据由各环境管理。

## 2026-11-13 实测

在原版 WorkBuddy 5.11.3、服务端 Pi 1.5.2 / Node 24.21.0 和 TokenLink / Hy4 上验证了以下场景。

| 场景 | 实测结果 |
| --- | --- |
| 流式对话与停止 | WorkBuddy 显示模型增量。点击停止后，远端 Pi 返回取消终态。 |
| 断线与续聊 | 生成期间主动断开 SSE，使用最后接收的事件 ID 重连并收到完整输出。完整退出 WorkBuddy 后重新打开原线程，验证了前文回忆。 |
| DOCX 处理 | 合成 DOCX 经上传、读取、指定文字替换后生成副本。模型续答使用了文档内容，下载文件通过 SHA-256 校验并显示在原生产物列表。服务重启后可重新获取同一产物，源文件保持原样。 |
| 安装包校验 | 实测前后原版 WorkBuddy 可执行文件与 `app.asar` 的 SHA-256 一致。 |

本次验证覆盖配置选定的 DOCX 文件和合成内容。原生附件拖放、其他 Office 格式、跨文本片段替换和多用户并发压测尚未验收。
