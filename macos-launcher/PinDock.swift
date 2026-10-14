import Foundation
import CoreFoundation

guard CommandLine.arguments.count == 4 else { fatalError("Expected launcher, original application and backup path") }
let target = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true).standardizedFileURL
let original = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true).standardizedFileURL
let backup = URL(fileURLWithPath: CommandLine.arguments[3])
let domain = "com.apple.dock" as CFString
let key = "persistent-apps" as CFString
guard let before = CFPreferencesCopyAppValue(key, domain) as? [[String: Any]] else { fatalError("Cannot read existing Dock entries") }
func entryURL(_ entry: [String: Any]) -> URL? {
    guard let tile = entry["tile-data"] as? [String: Any], let file = tile["file-data"] as? [String: Any], let string = file["_CFURLString"] as? String else { return nil }
    return (string.hasPrefix("file:") ? URL(string: string) : URL(fileURLWithPath: string))?.standardizedFileURL
}
let originalIndex = before.firstIndex { entryURL($0)?.path == original.path }
let targetIndex = before.firstIndex { entryURL($0)?.path == target.path }
let others = before.filter { entryURL($0)?.path != target.path && entryURL($0)?.path != original.path }
let originalTiles = before.filter { entryURL($0)?.path == original.path }
let record: [String: Any] = ["originalTiles": originalTiles, "originalIndex": originalIndex ?? before.count, "launcherPath": target.path]
let data = try PropertyListSerialization.data(fromPropertyList: record, format: .binary, options: 0)
if !FileManager.default.fileExists(atPath: backup.path) { try data.write(to: backup); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path) }
let entry: [String: Any] = ["GUID": UInt32.random(in: 1...UInt32.max), "tile-type": "file-tile", "tile-data": ["file-data": ["_CFURLString": target.absoluteString, "_CFURLStringType": 15], "file-label": "企业AI工作台", "file-type": 41, "bundle-identifier": "local.workbuddy.enterprise-ai-launcher", "dock-extra": false]]
var after = others
after.insert(entry, at: min(originalIndex ?? targetIndex ?? others.count, others.count))
CFPreferencesSetAppValue(key, after as CFArray, domain)
guard CFPreferencesAppSynchronize(domain) else { fatalError("Dock preferences could not be saved") }
let output: [String: Any] = ["pinned": true, "replacedOriginalPin": originalIndex != nil, "otherPinsPreserved": true, "pinnedCount": after.count]
print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
