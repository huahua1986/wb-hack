import Foundation
import PDFKit
import Vision
import AppKit

// Separate, bounded process: no PDF actions, links, scripts or external resources are opened.
enum ParseFailure: Error { case invalid, locked, tooLarge, tooManyPages, empty, ocr }
func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
    }
}
let maxBytes = Int(CommandLine.arguments.dropFirst().first ?? "0") ?? 0
let maxPages = Int(CommandLine.arguments.dropFirst(2).first ?? "0") ?? 0
func parse() throws -> [String: Any] {
    guard maxBytes > 0 && maxBytes <= 524288 && maxPages > 0 && maxPages <= 200 else { throw ParseFailure.invalid }
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
        data.append(chunk)
        if data.count > 25 * 1024 * 1024 { throw ParseFailure.tooLarge }
    }
    guard let document = PDFDocument(data: data) else { throw ParseFailure.invalid }
    if document.isLocked || !document.allowsCopying { throw ParseFailure.locked }
    guard document.pageCount > 0 else { throw ParseFailure.empty }
    if document.pageCount > maxPages { throw ParseFailure.tooManyPages }
    var parts: [String] = [], byteCount = 0, ocrPages = 0, blankPages = 0
    for index in 0..<document.pageCount {
        let text: String = try autoreleasepool {
            guard let page = document.page(at: index) else { throw ParseFailure.invalid }
            let text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
            ocrPages += 1
            let box = page.bounds(for: .mediaBox)
            guard box.width.isFinite && box.height.isFinite && box.width > 0 && box.height > 0 else { throw ParseFailure.invalid }
            let scale = min(2.0, 2400.0 / max(box.width, box.height))
            let size = NSSize(width: max(1, box.width * scale), height: max(1, box.height * scale))
            let image = page.thumbnail(of: size, for: .mediaBox)
            guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw ParseFailure.ocr }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]
            request.usesLanguageCorrection = true
            do { try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request]) }
            catch { throw ParseFailure.ocr }
            return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        }
        if text.isEmpty { blankPages += 1 }
        let part = "[第 \(index + 1) 页]\n\(text.isEmpty ? "[本页未识别到文字]" : text)"
        byteCount += part.utf8.count + 2
        if byteCount > maxBytes { throw ParseFailure.tooLarge }
        parts.append(part)
    }
    if blankPages == document.pageCount { throw ParseFailure.empty }
    var warnings: [String] = []
    if ocrPages > 0 { warnings.append("无文字层页面已使用本机 OCR，识别结果可能有误，请核对原文。") }
    if blankPages > 0 { warnings.append("\(blankPages) 页未识别到文字。") }
    return ["text": parts.joined(separator: "\n\n"), "format": "pdf", "pages": document.pageCount,
            "ocrPages": ocrPages, "warnings": warnings]
}
do { output(try parse()) }
catch {
    let code: String, message: String
    switch error {
    case ParseFailure.locked: code = "LOCKED"; message = "PDF 已加密或禁止复制，请解除保护后重新选择。"
    case ParseFailure.tooLarge: code = "TOO_LARGE"; message = "PDF 文件或解析后的文字超过限制，请拆分后选择。"
    case ParseFailure.tooManyPages: code = "TOO_MANY_PAGES"; message = "PDF 超过 200 页，请拆分后选择。"
    case ParseFailure.empty: code = "EMPTY"; message = "PDF 未识别到可用文字，请检查扫描清晰度或导出文本。"
    case ParseFailure.ocr: code = "OCR_FAILED"; message = "本机 OCR 未能完成，请导出清晰扫描件或文本后重试。"
    default: code = "INVALID"; message = "PDF 损坏或格式不受支持，请重新导出后选择。"
    }
    output(["error": ["code": "ATTACHMENT_DOCUMENT_" + code, "message": message]])
}
