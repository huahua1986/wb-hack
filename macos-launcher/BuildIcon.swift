import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: rep) else { fatalError("Icon context failed") }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    let edge = CGFloat(size)
    NSColor(calibratedRed: 0.02, green: 0.46, blue: 0.43, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: edge * 0.035, y: edge * 0.035, width: edge * 0.93, height: edge * 0.93), xRadius: edge * 0.20, yRadius: edge * 0.20).fill()
    let label = NSAttributedString(string: "企", attributes: [.font: NSFont.systemFont(ofSize: edge * 0.60, weight: .semibold), .foregroundColor: NSColor.white])
    let measured = label.size(); label.draw(at: NSPoint(x: (edge - measured.width) / 2, y: (edge - measured.height) / 2 + edge * 0.025))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { fatalError("Icon export failed") }
    let names = size == 16 ? ["icon_16x16.png"] : size == 32 ? ["icon_16x16@2x.png", "icon_32x32.png"] : size == 64 ? ["icon_32x32@2x.png"] : size == 128 ? ["icon_128x128.png"] : size == 256 ? ["icon_128x128@2x.png", "icon_256x256.png"] : size == 512 ? ["icon_256x256@2x.png", "icon_512x512.png"] : ["icon_512x512@2x.png"]
    for name in names { try png.write(to: directory.appendingPathComponent(name)) }
}
