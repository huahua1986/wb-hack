import AppKit
import Foundation

struct LauncherConfig: Decodable { let workspaceRoot: String }
struct LaunchResult: Decodable { let status: String; let pid: Int32; let appPath: String; let productName: String }
enum LauncherError: LocalizedError {
    case failed(String)
    var errorDescription: String? { if case .failed(let message) = self { return message }; return nil }
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private var launching = false
    private var workbuddyPID: Int32?
    private var terminationObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let root = NSMenuItem(); menu.addItem(root)
        let appMenu = NSMenu(); root.submenu = appMenu
        appMenu.addItem(withTitle: "打开企业AI工作台", action: #selector(openWorkbench), keyEquivalent: "o")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "退出启动应用", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier == self.workbuddyPID else { return }
            NSApp.terminate(nil)
        }
        openWorkbench()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWorkbench(); return false
    }

    @objc func openWorkbench() {
        guard !launching else { return }
        if let pid = workbuddyPID, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
            activate(app); return
        }
        launching = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                guard let configURL = Bundle.main.url(forResource: "launcher", withExtension: "json") else { throw LauncherError.failed("启动应用缺少配置，请重新安装。") }
                let config = try JSONDecoder().decode(LauncherConfig.self, from: Data(contentsOf: configURL))
                let root = URL(fileURLWithPath: config.workspaceRoot, isDirectory: true)
                let settingsURL = root.appendingPathComponent("workbuddy-launcher.json")
                let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: settingsURL)) as? [String: Any] ?? [:]
                let node = try self?.findNode(override: settings["nodeExecutable"] as? String ?? "")
                guard let node else { throw LauncherError.failed("未找到 Node.js 24 或更新版本。") }
                let helper = root.appendingPathComponent("auth-gateway/scripts/desktop-workbuddy.mjs")
                let (status, output) = try self?.run(node, arguments: [helper.path, "--config", settingsURL.path], directory: root, timeout: 45) ?? (-1, "启动应用已经退出。")
                guard status == 0 else { throw LauncherError.failed(String(output.suffix(2000))) }
                guard let line = output.split(separator: "\n").last(where: { $0.hasPrefix("{") }), let data = String(line).data(using: .utf8) else { throw LauncherError.failed("启动器未返回有效结果。") }
                let result = try JSONDecoder().decode(LaunchResult.self, from: data)
                DispatchQueue.main.async { self?.launching = false; self?.workbuddyPID = result.pid; self?.activateWhenReady(result.pid, attempts: 50) }
            } catch {
                DispatchQueue.main.async {
                    self?.launching = false
                    let alert = NSAlert(); alert.messageText = "企业AI工作台启动失败"; alert.informativeText = error.localizedDescription
                    alert.addButton(withTitle: "确定"); NSApp.activate(ignoringOtherApps: true); alert.runModal(); NSApp.terminate(nil)
                }
            }
        }
    }

    private func activate(_ app: NSRunningApplication) {
        if #available(macOS 14.0, *) { app.activate(from: NSRunningApplication.current, options: [.activateAllWindows]) }
        else { app.activate(options: [.activateIgnoringOtherApps, .activateAllWindows]) }
    }

    private func activateWhenReady(_ pid: Int32, attempts: Int) {
        if let app = NSRunningApplication(processIdentifier: pid), app.isFinishedLaunching, !app.isTerminated { activate(app); return }
        guard attempts > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.activateWhenReady(pid, attempts: attempts - 1) }
    }

    private func findNode(override: String) throws -> URL {
        let candidates = override.isEmpty
            ? (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { String($0) + "/node" } + ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
            : [override]
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            let url = URL(fileURLWithPath: candidate)
            let (status, output) = try run(url, arguments: ["-p", "Number(process.versions.node.split('.')[0])"], directory: nil, timeout: 4)
            if status == 0, let major = Int(output.trimmingCharacters(in: .whitespacesAndNewlines)), major >= 24 { return url }
        }
        throw LauncherError.failed("需要 Node.js 24 或更新版本。可在 workbuddy-launcher.json 配置 nodeExecutable。")
    }

    private func run(_ executable: URL, arguments: [String], directory: URL?, timeout: TimeInterval) throws -> (Int32, String) {
        let task = Process(); task.executableURL = executable; task.arguments = arguments; task.currentDirectoryURL = directory
        let pipe = Pipe(); task.standardOutput = pipe; task.standardError = pipe
        let done = DispatchSemaphore(value: 0)
        task.terminationHandler = { _ in done.signal() }
        try task.run()
        if done.wait(timeout: .now() + timeout) != .success { task.terminate(); throw LauncherError.failed("启动器等待超时，请检查网关和 WorkBuddy 状态。") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return (task.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}

let app = NSApplication.shared
let delegate = LauncherDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
