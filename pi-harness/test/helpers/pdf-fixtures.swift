import Foundation
import AppKit
import PDFKit

// All content is synthetic. The image PDF has no text layer, for real Vision OCR coverage.
let root = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
let size = NSSize(width: 612, height: 792)
func drawText(_ text: String, image: Bool = false) -> PDFPage {
    let view = NSView(frame: NSRect(origin: .zero, size: size))
    let drawing = NSImage(size: size)
    drawing.lockFocus()
    NSColor.white.setFill(); NSRect(origin: .zero, size: size).fill()
    (text as NSString).draw(at: NSPoint(x: 48, y: 680), withAttributes: [.font: NSFont.systemFont(ofSize: 24), .foregroundColor: NSColor.black])
    drawing.unlockFocus()
    if image { return PDFPage(image: drawing)! }
    let field = NSTextField(labelWithString: text)
    field.font = NSFont.systemFont(ofSize: 24); field.frame = NSRect(x: 48, y: 650, width: 520, height: 100)
    view.addSubview(field)
    return PDFDocument(data: view.dataWithPDF(inside: view.bounds))!.page(at: 0)!
}
let text = PDFDocument()
text.insert(drawText("PDF-TEXT-OK 金融测试"), at: 0)
text.insert(drawText("SECOND-PAGE 123456"), at: 1)
text.write(toFile: root + "/text.pdf")
let scan = PDFDocument(); scan.insert(drawText("SCAN-REPORT-2026", image: true), at: 0); scan.write(toFile: root + "/scan.pdf")
let blank = PDFDocument(); blank.insert(drawText("", image: true), at: 0); blank.write(toFile: root + "/blank.pdf")
text.write(to: URL(fileURLWithPath: root + "/encrypted.pdf"), withOptions: [.userPasswordOption: "synthetic-fixture", .ownerPasswordOption: "synthetic-owner"])
