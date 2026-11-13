# 原版 WorkBuddy 的 SSH Pi 会话

原版客户端通过现有 Electron 外挂添加「Pi 外部」会话来源。支持通过哈希校验的 5.11.2 和 5.11.3。Mac 上的外挂用系统 SSH 传输 JSONL，Pi、模型凭据和实际对话上下文位于服务器。

服务器以已有 SSH 账号运行 `scripts/remote-pi-rpc.cjs`，安装路径为 `/usr/local/libexec/workbuddy-pi-rpc`。该入口使用现有的 Node 24 和 `/usr/local/bin/pi`，从同一服务器账号的 `~/.pi/agent` 读取 `tokenlink/hy4`。每个线程有独立的远端目录和会话文件，位于 `~/.workbuddy-pi-ssh`。

在 Mac 上准备外部 Pi 配置，使用本机实际路径填写 `identityFile` 和 `knownHostsFile`。后者必须包含经过验证的服务器 ED25519 主机公钥。

```json
{
  "ssh": {
    "host": "21.130.240.28",
    "port": 36000,
    "user": "root",
    "identityFile": "/absolute/path/to/existing-ssh-key",
    "knownHostsFile": "/absolute/path/to/pinned-known-hosts"
  },
  "cwd": "/absolute/path/to/local-placeholder-directory",
  "stateDir": "/absolute/path/to/local-private-state",
  "agentDir": "/absolute/path/to/local-private-agent-directory",
  "provider": "tokenlink",
  "model": "hy4",
  "modelName": "远端 Pi · HY4"
}
```

完整退出 WorkBuddy 后，从工作区运行以下命令。原版窗口打开后，选择「Pi 外部」并发送纯文本。完整退出再用同一命令启动，会恢复上次选择和同一线程。普通原版启动入口只打开原版客户端。

```sh
node pi-harness/scripts/launch-stock-ssh.mjs /Applications/WorkBuddy.app /absolute/path/to/pi-config.json
```

基础远端入口接收纯文本对话、状态查询和停止请求。停止由远端 Pi 确认。

## 原版 5.11.3 的本机 Office 工具

在固定 ASAR 哈希的原版 WorkBuddy 5.11.3 上，可以显式启用 Office 模式。Pi 仍在服务器运行，外挂通过原版文档服务启动 Mac 上的 `editor_sdk`。SSH 传输工具定义、请求、审批和必要结果。文档打开、编辑、保存和文件快照都发生在 Mac。读取结果会发送给远端 Pi，并可能进入模型上下文。

Office 模式使用服务器的 `/usr/local/libexec/workbuddy-pi-office-rpc`。该入口与基础入口使用同一份 `scripts/remote-pi-rpc.cjs` 源码，以文件名区分模式。服务器还需要在 `/usr/local/libexec/workbuddy-pi-extensions/` 放置通过启动器哈希校验的 `src/native-feature-extension.mjs` 和 `package-dmg/approval-extension.mjs`。

在外部配置中保留原 SSH 字段。将 `cwd` 设为选中文档所在的本机目录，`stateDir` 和 `agentDir` 使用独立的 Office 配置目录。增加以下字段。暂存根目录使用 WorkBuddy 编辑引擎所在用户的临时目录，完整路径可以用 `path.join(fs.realpathSync(os.tmpdir()), 'workbuddy-editor-sdk-sandbox', 'tmp', 'document-save-staging')` 取得。

```json
{
  "sshOffice": {
    "stagingRoot": "/absolute/path/to/document-save-staging",
    "mode": "read",
    "documents": ["editor-sdk-smoke.docx"]
  }
}
```

`documents` 是 `cwd` 下显式允许操作的 DOCX 文件名。首次启动使用 `read`，在「Pi 外部」会话中指定要读的文件名并逐次批准工具操作。需要替换文字及保存时，使用同一 Office 工作目录和状态目录重新启动 `edit` 配置。保存后可点击会话顶部的「恢复本轮文档」，恢复保存前的本机字节。远端对话历史会保留。

实机验收使用合成 DOCX，验证了打开、读取、模型根据读出的内容续答、精确替换、保存和本机回退。恢复后的 DOCX 与验收前的 SHA-256 一致。此模式当前覆盖所选 DOCX 的受限操作。
