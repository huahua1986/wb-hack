# 本地文档解析依赖

这里的依赖独立于 PiEngine，不能用它们更新或覆盖 Pi 的锁定依赖。

开发环境准备：`npm ci --ignore-scripts --omit=dev --no-fund --prefix pi-harness/document-engine`。
锁定 yauzl 3.4.0（ZIP 容器）和 saxes 6.0.0（XML），完整传递依赖及 npm SHA-512 在 package-lock.json 中。初次安装的 `npm audit` 为 0 个已知漏洞，这只是安装时的注册表结果。

构建器校验整个 node_modules 文件树和锁文件的固定 SHA-256，只将依赖、许可证、package.json/package-lock.json 和编译后的 PDF 助手复制到应用 `Resources/DocumentEngine`，没有安装脚本或运行时下载。此 README 不进入应用。依赖升级必须重新核对来源、许可证、测试与构建 pin。

PDF 助手源文件为 `../native/pdf-parser.swift`，在打包时用 Apple SDK 编译为 arm64 macOS 12 目标，与应用一起签名。客户不需要安装编译器、Python、Office、Pi 或 Node。源码测试若需 PDF/OCR，可先执行：

```sh
swiftc -O -o pi-harness/document-engine/pdf-parser pi-harness/native/pdf-parser.swift -framework PDFKit -framework Vision -framework AppKit
node --test pi-harness/test/document-parser.test.mjs
```

受限沙箱可能无法访问 Vision 的本机 XPC 服务，导致 OCR_FAILED；应在正常 macOS 用户环境验证，不能据此关闭 OCR 错误检查。测试 PDF 全部由 `test/helpers/pdf-fixtures.swift` 生成，不含业务材料。旧 DOC/XLS/PPT、ODF 和加密文档未加入解析范围。

主要 API 来源：[yauzl](https://github.com/thejoshwolfe/yauzl)、[saxes](https://github.com/lddubeau/saxes)、[Apple PDFDocument](https://developer.apple.com/documentation/pdfkit/pdfdocument)、[Apple Vision 文字识别](https://developer.apple.com/documentation/vision/recognizing-text-in-images)。
