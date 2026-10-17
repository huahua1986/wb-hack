import AppKit
import CoreFoundation
import Darwin
import CoreGraphics

let args = CommandLine.arguments
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
func emit(_ value: [String: Any]) {
    print(String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
}
func fail(_ text: String) -> Never { FileHandle.standardError.write(Data((text + "\n").utf8)); exit(1) }
func dialog(_ message: String) {
    let alert = NSAlert(); alert.messageText = "WorkBuddy 企业配置"; alert.informativeText = message
    alert.addButton(withTitle: "确定"); application.activate(ignoringOtherApps: true); alert.runModal()
}
func processBirth(_ pid: pid_t) -> Date? {
    var info = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.stride
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == Int32(size), info.pbi_start_tvsec > 0 else { return nil }
    return Date(timeIntervalSince1970: Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000)
}
func hasMainWindow(_ pid: pid_t) -> Bool {
    guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
    return windows.contains { window in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double else { return false }
        return width >= 600 && height >= 400
    }
}
func entryPath(_ entry: [String: Any]) -> String? {
    guard let tile = entry["tile-data"] as? [String: Any], let file = tile["file-data"] as? [String: Any], let string = file["_CFURLString"] as? String else { return nil }
    return (string.hasPrefix("file:") ? URL(string: string) : URL(fileURLWithPath: string))?.standardizedFileURL.path
}
func defaultsCommand(_ arguments: [String]) -> Data {
    let task = Process(), output = Pipe()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/defaults"); task.arguments = arguments
    task.standardOutput = output; task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { fail("无法访问系统 Dock 偏好。") }
    let data = output.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
    guard task.terminationStatus == 0 else { fail("Dock 偏好保存失败，其他设置已保留。") }
    return data
}
func readDock() -> [[String: Any]] {
    guard let all = try? PropertyListSerialization.propertyList(from: defaultsCommand(["export", "com.apple.dock", "-"]), format: nil) as? [String: Any] else { fail("无法读取系统 Dock 偏好。") }
    return all["persistent-apps"] as? [[String: Any]] ?? []
}
guard args.count > 1 else { fail("缺少客户端操作。") }
switch args[1] {
case "observe":
    guard args.count == 3 else { fail("监听参数无效。") }
    let expected = URL(fileURLWithPath: args[2]).standardizedFileURL.path
    let executable = expected + "/Contents/MacOS/Electron"
    func matches(_ app: NSRunningApplication) -> Bool {
        app.bundleURL?.standardizedFileURL.path == expected && app.executableURL?.standardizedFileURL.path == executable
    }
    func identity(_ app: NSRunningApplication) -> [String: Any]? {
        guard matches(app), !app.isTerminated, let date = processBirth(app.processIdentifier) else { return nil }
        return ["pid": Int(app.processIdentifier), "launchedAt": date.timeIntervalSince1970 * 1000]
    }
    var seen = Set<pid_t>()
    let existing = NSWorkspace.shared.runningApplications.filter(matches)
    for app in existing { seen.insert(app.processIdentifier) }
    func event(_ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value)
        FileHandle.standardOutput.write(data + Data([10]))
    }
    func discovered(_ app: NSRunningApplication) {
        guard !seen.contains(app.processIdentifier), let value = identity(app) else { return }
        seen.insert(app.processIdentifier)
        event(["type": "launch", "app": value])
    }
    let center = NSWorkspace.shared.notificationCenter
    let launchObserver = center.addObserver(forName: NSWorkspace.willLaunchApplicationNotification, object: nil, queue: .main) { note in
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { discovered(app) }
    }
    let readyObserver = center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
        if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { discovered(app) }
    }
    let shutdownObserver = center.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { _ in
        event(["type": "session-ending"])
    }
    // NSWorkspace notifications omit some background launches; enumeration also recovers missed events.
    let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
        let current = NSWorkspace.shared.runningApplications.filter(matches)
        seen.formIntersection(Set(current.map { $0.processIdentifier }))
        for app in current { discovered(app) }
    }
    FileHandle.standardInput.readabilityHandler = { input in
        if input.availableData.isEmpty { exit(0) }
    }
    event(["type": "ready", "existing": existing.compactMap(identity)])
    withExtendedLifetime([launchObserver, readyObserver, shutdownObserver, timer] as [Any]) { RunLoop.main.run() }
case "handoff":
    guard args.count == 5, let pid = Int32(args[2]), let launchedAt = Double(args[4]) else { fail("接管参数无效。") }
    let expected = URL(fileURLWithPath: args[3]).standardizedFileURL.path
    guard let app = NSRunningApplication(processIdentifier: pid),
          app.bundleURL?.standardizedFileURL.path == expected,
          app.executableURL?.standardizedFileURL.path == expected + "/Contents/MacOS/Electron",
          let actual = processBirth(pid),
          abs(actual.timeIntervalSince1970 * 1000 - launchedAt) < 1,
          Date().timeIntervalSince(actual) >= 0, Date().timeIntervalSince(actual) < 8 else {
        fail("只允许接管刚刚启动且身份一致的原版进程，已有实例保持不变。")
    }
    let windowReady = hasMainWindow(pid)
    guard let latestBirth = processBirth(pid), abs(latestBirth.timeIntervalSince(actual)) < 0.001,
          Date().timeIntervalSince(actual) < 8 else { fail("进程身份或启动窗口已改变，停止接管。") }
    let method: String
    if windowReady {
        guard app.terminate() else { fail("原版拒绝正常退出，停止接管。") }
        method = "application-quit"
    } else {
        // A newly launched stock process can fail its own bootstrap before creating a window.
        // Limit SIGTERM to this verified fresh, windowless process; never escalate to SIGKILL.
        guard kill(pid, SIGTERM) == 0 else { fail("未能向新启动进程发送退出信号，停止接管。") }
        method = "startup-sigterm"
    }
    let deadline = Date().addingTimeInterval(6)
    while !app.isTerminated && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    guard app.isTerminated else { fail("原版进程尚未退出，停止接管，不追加 SIGKILL。") }
    emit(["terminated": true, "pid": Int(pid), "method": method])
case "open-url":
    guard args.count == 3, let url = URL(string: args[2]), url.scheme == "http", url.host == "127.0.0.1", url.path == "/setup", url.user == nil, url.password == nil else { fail("本机设置地址无效。") }
    guard NSWorkspace.shared.open(url) else { fail("无法打开浏览器，请联系管理员。") }
case "metadata":
    emit(["bundleIdentifier": Bundle.main.bundleIdentifier ?? "", "applicationName": Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? ""])
case "configure":
    let field = NSTextField(string: args.count > 2 ? args[2] : "")
    field.frame = NSRect(x: 0, y: 0, width: 400, height: 26)
    while true {
        let alert = NSAlert(); alert.messageText = "设置 WorkBuddy 企业认证地址"
        alert.informativeText = "首次配置一次即可。远程地址使用 HTTPS；本机测试可使用 http://127.0.0.1:8787。模型仍通过 WorkBuddy 自定义配置直连。"
        alert.accessoryView = field; alert.addButton(withTitle: "保存并启动"); alert.addButton(withTitle: "稍后配置")
        application.activate(ignoringOtherApps: true)
        if alert.runModal() != .alertFirstButtonReturn { emit(["cancelled": true]); exit(0) }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URLComponents(string: text), let scheme = url.scheme, let host = url.host,
           !host.isEmpty, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
           url.path.isEmpty || url.path == "/", scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)) {
            emit(["gateway": text, "cancelled": false]); exit(0)
        }
        dialog("请输入有效的 HTTPS 认证服务地址。本机 HTTP 仅支持 loopback，地址中不能包含账号、密码、路径或查询参数。")
    }
case "alert":
    dialog(args.count > 2 ? args[2] : "企业配置需要处理。")
case "activate":
    guard args.count == 4, let pid = Int32(args[2]) else { fail("启动结果无效。") }
    let expected = URL(fileURLWithPath: args[3]).standardizedFileURL.path
    for _ in 0..<50 {
        if let app = NSRunningApplication(processIdentifier: pid), app.bundleURL?.standardizedFileURL.path == expected, app.isFinishedLaunching {
            if #available(macOS 14.0, *) { app.activate(from: NSRunningApplication.current, options: [.activateAllWindows]) }
            else { app.activate(options: [.activateIgnoringOtherApps, .activateAllWindows]) }
            exit(0)
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    fail("工作台未能在预期时间内打开。")
case "pin":
    guard args.count == 5 else { fail("Dock 配置参数无效。") }
    let original = URL(fileURLWithPath: args[2]).standardizedFileURL
    let backup = URL(fileURLWithPath: args[3]), legacy = args[4]
    let domain = "com.apple.dock" as CFString, key = "persistent-apps" as CFString
    guard !CFPreferencesAppValueIsForced(key, domain) else { fail("Dock 固定项目由企业策略管理，请联系管理员配置原版图标。") }
    let before = readDock()
    let existing = before.firstIndex { entryPath($0) == original.path }
    let legacyIndex = legacy.isEmpty ? nil : before.firstIndex { entryPath($0) == legacy }
    let previous: [String: Any] = ["before": before, "originalPath": original.path, "legacyPath": legacy]
    if !FileManager.default.fileExists(atPath: backup.path) {
        try PropertyListSerialization.data(fromPropertyList: previous, format: .binary, options: 0).write(to: backup, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path)
    }
    var after = before.filter { entryPath($0) != original.path && (legacy.isEmpty || entryPath($0) != legacy) }
    let freshItem: [String: Any] = ["GUID": UInt32.random(in: 1...UInt32.max), "tile-type": "file-tile",
        "tile-data": ["file-data": ["_CFURLString": original.absoluteString, "_CFURLStringType": 15],
                      "file-label": "WorkBuddy", "file-type": 41, "bundle-identifier": "com.tencent.workbuddy.mac", "dock-extra": false]]
    let item = existing.map { before[$0] } ?? freshItem
    after.insert(item, at: min(existing ?? legacyIndex ?? after.count, after.count))
    let entries = try after.map { String(data: try PropertyListSerialization.data(fromPropertyList: $0, format: .xml, options: 0), encoding: .utf8)! }
    _ = defaultsCommand(["write", "com.apple.dock", "persistent-apps", "-array"] + entries)
    let observed = readDock()
    guard observed.filter({ entryPath($0) == original.path }).count == 1,
          legacy.isEmpty || !observed.contains(where: { entryPath($0) == legacy }) else { fail("Dock 写入未生效，请联系管理员。") }
    emit(["pinnedOriginal": true, "otherPinsPreserved": true])
case "check-pin":
    guard args.count == 4 else { fail("Dock 检查参数无效。") }
    let entries = readDock()
    emit(["originalPins": entries.filter { entryPath($0) == args[2] }.count,
          "legacyPins": args[3].isEmpty ? 0 : entries.filter { entryPath($0) == args[3] }.count])
default: fail("未知客户端操作。")
}
