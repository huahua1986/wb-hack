# 独立 Pi 安装包构建工具（0.4.13 / WorkBuddy 5.11.1 / Pi 1.5.0）

`build.mjs` 从经核验的原版 WorkBuddy 5.11.1 复制生成“金融buddy”候选，内置 Pi 1.5.0、Node 24.21.0 与离线 grep/find 工具。保留官方登录、官方模型桥和原生界面资源，移除 CodeBuddy 执行器。0.4.13包含P0设置/压缩、产物/Diff、协调回退，补齐文件树和产物卡Markdown的刷新及终态同步；包含0.4.4文档解析。首页预建及正式发送只使用已就绪的 Pi 会话，登录初始化期间不会创建原生会话。首页路由、预览补丁与原生页面资源按 5.11.1 固定源校验；金色图标保留，详见[P0说明](../../docs/workbuddy-pi-p0.md)。默认新任务分配 `~/WorkBuddy/YYYY-MM-DD-HH-mm-ss`，默认自动执行，可切回逐次确认。构建通过仍需该候选的桌面验收，本次状态见交付目录的验收说明。

原版当前安装可能已自动更新；本构建只接受固定5.11.1源，主补丁合同测试用 `WORKBUDDY_TEST_SOURCE_ASAR` 指向已验证的原版 ASAR。历史 5.9.2 测试使用原版保留件，避免把它与 5.11.1 合同混用。

源安装包只读；候选 Bundle ID 为 `com.tencent.workbuddy.mac.pi.local`，沿用 `~/Library/Application Support/WorkBuddy-Pi-5.9.1`，不搬迁已有 Pi 登录、会话或工作目录。构建工具不启动候选、不登录、不请求模型，也不复制构建者的账号、配置、会话或运行数据。既有企业启动监听器保持停用。

## 构建与验收顺序

需要 macOS Apple Silicon、固定版本/哈希的原版 WorkBuddy 5.11.1，以及经过来源核验的 Pi 1.5.0 release 和 Node runtime。Pi release 必须包含固定 `node_modules`、工具及许可证、lock 与来源记录；构建不调用安装器，不访问 npm，不下载依赖。Node 目录只含固定哈希的 `node` 和 `LICENSE`，通过校验才执行 `node --version`。

文档解析依赖需先按[DocumentEngine说明](../document-engine/README.md)准备固定锁文件对应的离线依赖。构建机还需Apple Command Line Tools / Swift SDK；打包时编译PDFKit/Vision助手，客户机器无需编译器。依赖树、锁文件与编译后助手分别校验；不改PiEngine的依赖图。

先生成候选应用（下方为本仓库已核验输入的示例路径）：

```sh
node pi-harness/package-dmg/build.mjs \
  --source-app "$PWD/evidence/pi-latest-20261104/source/WorkBuddy.app" \
  --node-runtime "$HOME/Library/Application Support/EnterpriseWorkbenchClient/program/runtime" \
  --pi-release "$PWD/evidence/pi-latest-20261104/runtime" \
  --output "$PWD/dist/金融buddy-5.11.1-test-0.4.13" \
  --stage-only
```

这些 `evidence` 输入被 Git 忽略，不随源码分发；其他构建机需要独立准备并验证相同输入。也可把 `--source-app` 指向版本和哈希匹配的 `/Applications/WorkBuddy.app`。`--output` 必须为不存在的新目录，父目录须存在。

0.4.13 禁止使用 `--base-build` 增量入口，不能把 5.9.1 ASAR 改版本后充当 5.11.1。历史 0.3.0/0.3.1 固定基线只读核验逻辑保留供追溯，旧构建与镜像不改写。5.11.1 验证来源、原版签名、ASAR、完整界面资源及精确补丁锚点；任何漂移都拒绝构建。Pi 的原始依赖/工具树与重新签名后嵌入树分别记录，避免把签名后的字节称为 npm 原始字节。

候选位于 `output/staging/金融buddy.app`，按层 ad hoc 签名，保留 Applications 拖拽快捷方式；不会安装或覆盖 `/Applications` 中的应用。构建不剥离 quarantine。随后须在该冻结候选上验证目录隔离、自动/手动权限、官方模型、停止和完整退出恢复。构建通过不代表运行验收通过。

验收后封装同一副本：

```sh
node pi-harness/package-dmg/build.mjs \
  --finalize "$PWD/dist/金融buddy-5.11.1-test-0.4.13"
```

`--finalize` 重新检查 Bundle ID/版本、ASAR/header、全部 packed 文件完整性、旧执行器移除、产品配置、原生界面资源和 Fuse；保留已验收签名并 strict/deep 验签，创建压缩只读 UDZO DMG，再运行 `hdiutil verify`。封装不再重签应用；候选变化时须先显式签名并重新测试，不能继承旧副本的验收结论。省略 `--stage-only` 可连续构建和封装，但不会自动完成 GUI 验收。

输出包含：

- `金融buddy-5.11.1-0.4.13-arm64-internal.dmg`。
- `manifest.json`：输入来源/哈希、版本、ASAR、Fuse、补丁、运行源码与嵌入依赖、签名信息。
- `安装说明.md`：目录、自动执行、回退、账号与许可边界。
- `SHA256SUMS`：交付文件 SHA-256；验收记录应与这些文件一并交付。

构建移除 `cli/bin`、`cli/dist`、`cli/node_modules`、`node_modules/@genie/agent-harness` 的 header 和 unpacked 实体，保留产品配置、原插件/扩展和版权许可。来源固定的官方模型 SDK 仅用于传输协议，不恢复旧 agent loop。Pi 只包含 release 的依赖、受控扩展和运行源码，不包含 tests/docs/evidence 或用户配置。相对内部 symlink 可保留；绝对、悬空及越界链接被拒绝。

原版 Fuse 保持不变。资源修改后使用 ad hoc 签名，因此这是未公证的内部包；正式分发仍需权利授权、Developer ID 签名和公证。最低系统限制以嵌入 runtime/原版应用为准，干净新机验收须单独完成。

以下为历史版本实现和验收记录，其版本、逐次审批及测试数字不代表 0.4.13 的当前配置。

## 0.2.8 运行配置与迁移

应用仍使用 `~/Library/Application Support/WorkBuddy-Pi-5.9.1` 的独立目录和既有官方账号缓存。Pi 配置强制 `officialOnly: true`、`provider: "workbuddy-official"`，首次默认模型 `hy4`；原生首页显式选择的模型在创建会话前应用，后续按线程保留。`pi/agent/models.json` 为 `{ "providers": {} }`，由显式官方 provider 扩展从模型桥加载动态目录，不写官方令牌或自定义服务凭据。

启动入口设定 `WORKBUDDY_PI_OFFICIAL_BUILD=1`、`WORKBUDDY_PI_MODEL_BRIDGE_DIR=<piHome>/bridge`，只在该独立候选挂载官方模型桥。桥随权威 daemon 使用官方认证状态；Pi 获得的 locator 只含回环端口与短期本地 ticket。`pi/bridge` 为 0700，locator 为 0600；模型授权失败或登录失效应由登录/刷新流程处理，不降级到旧直连地址。

迁移改写三个配置文件前，先把已有 `pi/pi-config.json`、`pi/agent/models.json`、`pi/agent/settings.json` 原始字节备份到 `pi/migration-backups/official-model-0.2.8-*`。目录为 0700，文件为 0600，不打印私有内容；异常配置、symlink 或异常备份目录会拒绝迁移。备份不进入应用或 DMG。原账号文件、thread/session 和工作区不删除，旧线程模型由运行适配层切换到官方模式，不能据旧记录恢复外部服务调用。已有 0.2.0、0.2.1、0.2.2 候选、制品及历史备份不改写，新版本使用新的 output。

模型桥需要 `@tencent/tcaicc` 1.4.0 的传输协议块，依赖四个 Node 内置模块。构建器从通过签名及哈希核验的原版 ASAR 中读取 `cli/dist/lazy-lite-wb/6951.67f39af7.mjs`，校验其长度 114,429 字节及 SHA-256 `c62e93beba2a2fc16aadfd8120d920883ec79bdd54f72a715c5bdfd1bf959dee`，写入候选的 `pi-harness/src/official-aicc-sdk.mjs`。候选校验会再次核对文件和 manifest。仓库仅记录来源元数据。若工作区存在同名本地提取件，构建也以原 ASAR 为准。源码测试中依赖本地 SDK 的真实加解密用例在提取件缺失时跳过。

`official-aicc-sdk.provenance.json` 记录来源和能确认的版权/许可状态；原包没有独立 SDK 许可材料，因此不宣称已获得重新分发授权，正式分发前需要完成许可审核。原应用版权和依赖许可继续保留。0.1.1 的本地模型验收记录是历史结果，不能作为 0.2.8 官方模型实测结果。

## 0.2.8 原生界面模式

打包入口固定传入 exclusive:true、nativeUi:true：Pi仍独占新本地对话执行，但不再接管整个界面。原生首页/新建/导航/模型选择器与输入组件保留，不注入Pi徽章、自制模型浮层、placeholder覆盖或隐藏控件CSS。对话关联的任务数据按原生工作区、排序、分页和listChange快照合同补充。旧原生本地历史仅只读展示，不允许focus/ensureRuntime唤起旧CLI。

构建记录并比较原版与候选全部 renderer 资源整体指纹；本机1,958项一致，任何意外修改导致失败。171项Pi回归通过、1项opt-in另跑真实Pi本地协议通过；当前同一候选已完成原生首页发送、Hy4 对话、单次审批、停止、导航和完整退出恢复，最终 DMG 另做只读复核。详细边界见[原生界面说明](../../docs/workbuddy-pi-native-ui.md)。

0.2.8 修复原生命周期默认 setSandboxMode(true) 同步被误拒的问题：仅兼容偏好同步并保持 useSandboxCLI=false，不启用原生沙箱，不改变Pi工具单次审批。新增原版249字节消费者golden回归及源码语法预检。0.2.7的界面/导航/模型菜单已实测，首发未产生模型请求；0.2.8 已独立实测通过首发、审批、停止、导航、完整退出后的历史与无工具上下文续问。

## 0.2.6 名称修改

金融buddy 的显示名和内部 CFBundleName 同步更新，同时在副本内重命名四个 Helper 的包目录、可执行文件、CFBundleName/DisplayName/Executable。辅助函数仅接受指定 Pi Bundle ID 和金融buddy.app；拒绝已存在目标，验证旧／新布局及签名前二进制 SHA-256 不变。Helper Bundle ID 与原权限保留，原版不改。签名阶段覆盖全部新路径。

src/branding.cjs 处理窗口、侧栏和欢迎文案的 React 重绘／重载，并同步应用菜单标签；只作用于精确本地 renderer，不注入远程官方页面。登录和数据仍使用原独立目录。原有 16 个运行源码保持 0.2.2 哈希，品牌／打包测试 19 项通过，Pi 回归 151 项通过、1 项 opt-in 跳过。0.2.6 已实测系统菜单（含关于／隐藏／退出）、窗口及侧栏名称，完整退出清理后重启不回退；官方登录、原线程和 Hy4 选择恢复，模型请求为零。对应外部名称实测报告和 8 文件校验清单已提供，程序及 DMG 未因验收改变。

0.2.3 仅改内部名而未改 Helper 导致启动失败，已撤回；0.2.5 的窗口／侧栏正常，但系统菜单仍取旧内部名。Electron 的 [Helper 路径](https://github.com/electron/electron/blob/main/shell/app/electron_main_delegate_mac.mm) 按 [CFBundleName](https://github.com/electron/electron/blob/main/shell/common/application_info_mac.mm) 查找，所以需要成组调整原生名称。

## 0.2.2 本机实机验收

2026-10-24，同一 0.2.2 候选完成原生官方 `hy4-preview-ioa` 文本、write 单次允许、停止实际官方上游、完整退出后的官方登录／所选 Hy4／Pi session 恢复，以及新任务默认 Hy4 响应。测试文件在批准前不存在，批准后内容匹配；重启后不调用工具仍能正确回答此前内容。正常退出后所属进程、回环 locator 和 Host lock 均清理。原版核心哈希和官方 strict 签名复核不变。

完整串行回归共 323 项，322 通过，1 项 opt-in 跳过；候选内置真实 Pi/Node 与本机假模型桥另跑 1/1 通过。22 个构建源码哈希与 manifest 相符，其中 16 个运行源码与应用内容一致。真实 Hy4 通过不代表目录内其他模型逐个在线验收；实际令牌过期、远端 AICC TEE、整机重启、干净新机和正式签名公证未覆盖。最终 DMG 的尺寸、SHA-256 与只读挂载复核结果见[独立安装包说明](../../docs/workbuddy-pi-dmg.md)及交付目录中的验收记录。

## 历史 0.1.1 本机实机验收

2026-10-24，独立候选完成官方登录、Pi 对话、write/Bash 单次允许、拒绝 write、新建任务、正常退出清理与登录/真实 Pi session 上下文恢复。最终审批面板显示实际命令 JSON，Host 仍记录 `allow-once`；完整回归 268/268 通过。对最终同一候选封装并只读挂载复核的交付记录见[独立安装包说明](../../docs/workbuddy-pi-dmg.md)。

20 项 Renderer 测试覆盖了首次登录弹窗背后会话壳提前出现、原生首页等待已移除模型服务、任务空白快照过期和审批 metadata 合同。源码与最终副本哈希已核对。内置 Node 的 Mach-O 最低系统版本为 macOS 13.5；整包仅在本机 macOS 26.7.1 Apple Silicon 实测。以上不等于客户部署、正式签名/公证或原生功能全量兼容。

## ASAR 工具接口

`asar.mjs` 是主构建脚本使用的低层工具，要求 Node.js 22 或更新版本，不依赖网络下载或第三方安装。它不启动 WorkBuddy，不修改源安装包，不操作签名、系统设置、DMG 或 `.unpacked` 实体文件。

```js
import fs from 'node:fs';
import { inspectAsar, repackAsar } from './asar.mjs';

const source = inspectAsar('/path/to/source.app/Contents/Resources/app.asar');
const metadata = JSON.parse(source.read('package.json').toString('utf8'));
const result = repackAsar({
  input: '/path/to/source.app/Contents/Resources/app.asar',
  output: '/path/to/staging/app.new.asar', // 必须尚不存在
  replacements: new Map([
    ['package.json', Buffer.from(JSON.stringify({ ...metadata, main: 'pi-bootstrap.cjs' }))],
  ]),
  additions: new Map([
    ['pi-bootstrap.cjs', fs.readFileSync('/path/to/build/bootstrap.cjs')],
  ]),
  remove: (member) => member === 'cli',
});
console.log(result.headerHash); // 用于候选包的 ElectronAsarIntegrity
```

示例仅说明接口，不代表完整可运行安装包。官方登录、Pi 引擎、模型配置、版权文件保留、签名和 DMG 流程由主构建脚本负责。

`inspectAsar(path)` 同步读取并验证 ASAR v1 Pickle header，返回：

- `header`：解析的 JSON 目录树。调用者应视为只读。
- `dataOffset`、`headerSize`：packed 数据起点及 header Pickle 长度。
- `headerHash`：**原始 header JSON UTF-8 字节**的 SHA-256，不是整个 ASAR 的哈希。
- `entries`：包含目录、文件、链接的 `{ path, entry }` 数组。
- `read(member)`：显式读取单个 packed 或 unpacked 文件，校验 size 及已提供的 SHA-256/分块哈希；目录不可读。解析 header 不会解出所有成员。
- `sourceStat`：源文件身份与更新时间，供重打包前检查源文件未被替换。

`repackAsar(options)` 同步使用 1 MiB 缓冲流式复制未修改 packed 成员，检查原 integrity；只在内存保留 header 和显式传入的修改内容。现有成员的 `executable`、`unpacked` 以及其他元数据保留；所有 packed offset 重排。替换和增加的文件生成完整 SHA-256 及分块哈希，默认 blockSize 为 4 MiB，替换时沿用原 blockSize。零字节文件有一个空内容分块哈希。

`replacements` 和 `additions` 都是 `Map<string, Buffer>`，也可传入值 `{ data: Buffer, unpacked?: boolean, executable?: boolean }`。增加默认 packed；替换默认沿用原 unpacked/executable 标志。替换必须命中现有普通文件；增加必须为新路径；不接受对目录或链接的直接替换。需要替换文件类型时应由上层拆成明确、可审查的构建步骤。

`remove(path, entry)` 会收到路径与元数据副本；返回真时删除该成员及整个子树。删除 `cli` 目录会同时从 header 中删除其子目录、文件及链接，不会留下旧 CLI 的目录项；如果其他保留链接因此悬空，构建失败。增加、替换与删除冲突也会失败。

返回值包括：

- `headerHash`、`entries`、`packedCount`、`unpackedCount`、`packedBytes`。
- `removedPaths`：删除的目录、文件、链接路径。
- `unpackedWrites`：`Map<member, Buffer>`，仅包含本次新增或替换、且最终仍为 unpacked 的内容。

主构建脚本必须在**候选包副本**中按 `removedPaths` 清理 `.unpacked` 内容，写入 `unpackedWrites`，并复制其余 unpacked 文件和链接。工具不会创建 `.unpacked`，避免源包实体与目标包实体混写。unpacked 转为 packed 的旧实体也需上层清理。必要时检查候选目录中是否存在未被 header 引用的旧 CLI 文件。

输入与输出不得相同；输出用独占创建，已有文件或硬链接不会被覆盖。异常只移除本次已创建的输出。成员名不允许绝对路径、盘符、反斜杠、NUL、空段、`.` 或 `..`。unpacked 读取解析真实路径并检查仍位于该 ASAR 的 `.unpacked` 目录，链接递归有上限。输入已知整体哈希的检查仍应由主构建脚本完成。

## 完整性与签名边界

Pickle、integrity 和 offset 格式参考 Electron 官方实现：[disk.ts](https://github.com/electron/asar/blob/main/src/disk.ts)、[pickle.ts](https://github.com/electron/asar/blob/main/src/pickle.ts)、[integrity.ts](https://github.com/electron/asar/blob/main/src/integrity.ts)。本机原版 WorkBuddy 5.9.1 `Info.plist` 中 `Resources/app.asar` 的 `ElectronAsarIntegrity` 与工具算出的 header JSON 哈希一致：`3bca3c77e7a05bb6af9bf4506964da4de527ec92f3f9922e26b242a4364f0ca6`。

候选包修改后必须更新其 `Info.plist` 对应 ASAR hash，再重新签名，不能关闭 Electron fuse 或 ASAR 完整性检查。签名应从内部新增/修改的 Mach-O、helper、framework 到外部 `.app` 按层执行，主程序沿用已核对的必要 entitlement，并对最终候选执行 `codesign --verify --deep --strict`。不能只修改资源后沿用腾讯原签名，也不能只用 `--deep` 作为替代分层签名的构建步骤。

本机只读检查到原版主程序启用了 hardened runtime，entitlement 为 JIT、unsigned executable memory、disable library validation、音频输入、用户选择文件读写、网络 client/server。该清单仅是当前原版事实；新增 Pi/Node 的 entitlement 应按其实际需求最小化配置。无可用 Developer ID 和公证流程时，ad hoc 签名的 DMG 只能作为内部验证包交付，不代表通过 Gatekeeper 的正式分发包。不得对 `/Applications/WorkBuddy.app` 就地重签。

## 工具验证

```sh
node --test pi-harness/test/asar.test.mjs pi-harness/test/package-dmg-build.test.mjs \
  pi-harness/test/dmg-bootstrap.test.mjs pi-harness/test/dmg-patches.test.mjs
```

测试覆盖 packed/unpacked、修改/增加/删除、可执行标志、空文件与 4 MiB 分块边界、每个输出 offset 和 integrity、危险路径、覆盖拒绝、损坏内容、截断 header、悬空链接、unpacked 路径逃逸、构建参数隔离、npm symlink 安全、拒绝原版名称应用签名、SDK 篡改/来源错误拒绝，以及官方配置迁移备份、旧账号/线程保留和重启选型保持。

2026-10-24 本机额外将原版 ASAR 流式重打包到临时文件，逐个读取并复核全部 6,601 个 packed 文件后删除临时副本；11,244 个目录项与 179,384,215 字节 packed 内容均通过格式与 integrity 检查。此项验证覆盖打包格式，不能代替候选 `.app` 的 Electron 实际启动、官方登录、Pi 对话及 DMG 安装验证。
