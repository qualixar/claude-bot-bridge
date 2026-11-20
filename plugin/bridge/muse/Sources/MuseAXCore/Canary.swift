import Foundation

/// Version of this muse-ax build. Keep equal to plugin/.claude-plugin/plugin.json and binary-manifest.json
/// (a test and the release workflow both check it).
public enum BridgeInfo {
    public static let version = "0.1.0"
}

public enum CanaryDecision: Equatable {
    case unchanged
    /// No version recorded yet: record a baseline without announcing an "update".
    case firstRun
    case changed(from: String)
}

public enum Canary {
    public static func decide(lastSeen: String?, current: String) -> CanaryDecision {
        guard let last = lastSeen else { return .firstRun }
        return last == current ? .unchanged : .changed(from: last)
    }

    /// Versions end up in an AppleScript string: keep only characters that cannot break out of it.
    static func sanitize(_ v: String) -> String {
        String(v.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_") })
    }

    public static func notification(version: String, ok: Bool) -> String {
        let v = sanitize(version)
        return ok ? "Muse updated to \(v): bridge OK"
                  : "Muse \(v) changed its layout: tasks will go through the board until rules update"
    }

    public static func notTrustedNotification(version: String) -> String {
        "Muse \(sanitize(version)) is running: grant muse-ax Accessibility permission so the update check can run"
    }

    public static func osascriptArguments(text: String) -> [String] {
        let esc = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        return ["-e", "display notification \"\(esc)\" with title \"Claude Bot Bridge\""]
    }
}
