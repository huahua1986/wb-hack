# 原版协议测试夹具

这些片段用于在不启动桌面客户端的情况下回放原版消费者，检查本后端返回值的兼容性。它们不是本项目实现，也不包含 WorkBuddy 安装包、整包反编译代码、账号或运行时凭据。

| 文件 | 来源与用途 |
| --- | --- |
| `AccountScopedExternalLinkAuthenticationProvider.js` | WorkBuddy 5.8.0 认证 provider，回放登录、查询账号和刷新 |
| `expert-consumers.json` | WorkBuddy 5.8.1 专家目录消费者与 DTO 映射 |
| `skill-consumers.json` | WorkBuddy 5.8.1 技能展示、下载与安装元数据消费者 |
| `cli-process-env.js` | WorkBuddy 5.8.1 后台环境过滤，验证附加 CA 的外部缓存路径 |
| `connector-consumers.json` | WorkBuddy 5.8.1 连接器转换所需的六段函数，排除原始 1.3MB 模块的其他内容 |

`manifest.json` 记录本机取证来源路径、夹具 SHA-256，以及连接器原始模块 SHA-256。原取证目录 `evidence/` 不进入 Git；干净检出只依赖本目录夹具。复制的四份片段字节未改写，连接器的每段函数保持原内容。

测试替换依赖注入与 HTTP 操作以接入本地测试后端，不调用腾讯登录服务。通过回放不代表其他客户端版本或真实桌面交互已验收。
