import Foundation
import MuseAXCore

/// `muse-ax canary`: run hourly by launchd. When the Muse version changed since last time, run the read-only
/// selftest, refresh the rules, record the result and tell the user with a macOS notification.
enum CanaryRunner {
    static let notTrustedNoticeEveryHours = 24.0

    static func run(bot: BotDriver, notify: Bool) throws -> [String: Any] {
        let home = RulesStore.home()
        for name in ["canary.log", "canary.err.log"] { LogRotation.trim(home.appendingPathComponent("logs").appendingPathComponent(name)) }
        guard bot.isRunning() else { return ["changed": false, "skipped": "muse_not_running"] }
        guard let version = bot.runningVersion() else { return ["changed": false, "skipped": "muse_version_unreadable"] }
        let state = StateStore.read(home: home)
        let decision = Canary.decide(lastSeen: state["lastSeenMuseVersion"] as? String, current: version)
        guard decision != .unchanged else { return ["changed": false, "muse_version": version] }

        var test = selftestOutcome(bot)
        if test.code == "not_trusted" { return notTrusted(version, state, home, notify) }
        let rules = RulesCommands.update(bot: bot)
        if !test.ok, rules["updated"] as? Bool == true { test = selftestOutcome(bot) }
        try StateStore.merge(["lastSeenMuseVersion": version, "lastCanary": [
            "at": ISO8601DateFormatter().string(from: Date()), "muse_version": version,
            "selftest": test.ok ? "ok" : "failed", "detail": test.detail, "rules_update": rules["reason"] as Any,
        ]], home: home)
        let announce = notify && !(decision == .firstRun && test.ok)
        if announce { Notifier.post(Canary.notification(version: version, ok: test.ok)) }
        return ["changed": true, "first_run": decision == .firstRun, "muse_version": version,
                "selftest_ok": test.ok, "detail": test.detail, "rules_update": rules, "notified": announce]
    }

    /// The launchd job runs muse-ax itself, which then needs its own Accessibility permission. Do not record the
    /// version (the check should run again once permission exists) and nag at most once a day.
    static func notTrusted(_ version: String, _ state: [String: Any], _ home: URL, _ notify: Bool) -> [String: Any] {
        let last = (state["canaryTrustNoticeAt"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
        let due = last.map { Date().timeIntervalSince($0) > notTrustedNoticeEveryHours * 3600 } ?? true
        if notify && due {
            Notifier.post(Canary.notTrustedNotification(version: version))
            try? StateStore.merge(["canaryTrustNoticeAt": ISO8601DateFormatter().string(from: Date())], home: home)
        }
        return ["changed": false, "muse_version": version, "skipped": "not_trusted"]
    }

    static func selftestOutcome(_ bot: BotDriver) -> (ok: Bool, code: String, detail: String) {
        do { _ = try bot.selftest(); return (true, "ok", "all anchors found") }
        catch let e as MuseError { return (false, e.code, e.message) }
        catch { return (false, "error", "\(error)") }
    }
}

enum Notifier {
    static func post(_ text: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = Canary.osascriptArguments(text: text)
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit()
    }
}
