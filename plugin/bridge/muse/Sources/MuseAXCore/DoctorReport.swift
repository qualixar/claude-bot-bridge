import Foundation

public struct LockInfo: Equatable {
    public let held: Bool
    public let pid: Int32?
    public let alive: Bool?
    public let ageSeconds: Int?
    public init(held: Bool, pid: Int32?, alive: Bool?, ageSeconds: Int?) { self.held = held; self.pid = pid; self.alive = alive; self.ageSeconds = ageSeconds }
    public static let free = LockInfo(held: false, pid: nil, alive: nil, ageSeconds: nil)
}

extension UILock {
    /// Read-only look at the UI lock file: is it there, who owns it, is that process alive, how old is the lock.
    public static func state(home: URL, now: Date = Date()) -> LockInfo {
        let url = path(home: home)
        guard FileManager.default.fileExists(atPath: url.path) else { return .free }
        let age = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date).map { max(0, Int(now.timeIntervalSince($0))) }
        let pid = (try? String(contentsOf: url, encoding: .utf8)).flatMap { $0.split(separator: "\n").first.flatMap { Int32($0) } }
        return LockInfo(held: true, pid: pid, alive: pid.map { FileLock.processAlive($0) }, ageSeconds: age)
    }
}

public struct DoctorFacts {
    public var bot: String
    public var binaryVersion: String
    public var app: AppDiagnostics
    public var rulesChannel: String
    public var keyset: KeysetState
    public var lock: LockInfo
    /// Raw journal rows; only `at` and `outcome` are ever shown.
    public var sends: [[String: Any]]
    public init(bot: String, binaryVersion: String, app: AppDiagnostics, rulesChannel: String, keyset: KeysetState, lock: LockInfo, sends: [[String: Any]]) {
        self.bot = bot; self.binaryVersion = binaryVersion; self.app = app; self.rulesChannel = rulesChannel
        self.keyset = keyset; self.lock = lock; self.sends = sends
    }
}

/// The paste-ready diagnostic of `muse-ax doctor`. It carries versions, layout, anchor results, rules and key state and
/// the time and outcome of the last sends. It never carries a chat name, message text or any other content.
public enum DoctorReport {
    public static let lastSendsShown = 5

    static func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

    static func sends(_ f: DoctorFacts) -> [[String: String]] {
        f.sends.suffix(lastSendsShown).map { ["at": $0["at"] as? String ?? "?", "outcome": $0["outcome"] as? String ?? "?"] }
    }

    public static func keysetFields(_ s: KeysetState) -> [String: Any] {
        func describe(_ k: Keyset) -> [String: Any] {
            ["issued_at": iso(k.issuedAt), "not_after": iso(k.notAfter), "revoked": k.revoked.count,
             "keys": k.keys.map { ["id": $0.id, "use": $0.use, "not_after": iso($0.notAfter)] }]
        }
        var out: [String: Any] = ["state": s.name]
        switch s {
        case .absent: break
        case .invalid(let why): out["reason"] = why
        case .expired(let k): out.merge(describe(k)) { $1 }
        case .valid(let k, let src): out.merge(describe(k)) { $1 }; out["source"] = src
        }
        return out
    }

    public static func fields(_ f: DoctorFacts) -> [String: Any] {
        let a = f.app
        var app: [String: Any] = ["running": a.running, "ax_trusted": a.axTrusted,
                                  "version": a.versionShort as Any? ?? NSNull(), "build": a.versionBuild as Any? ?? NSNull(),
                                  "layout": a.layout as Any? ?? NSNull(), "profile": a.profile as Any? ?? NSNull(),
                                  "version_check": a.versionCheck as Any? ?? NSNull(), "verified_versions": a.verifiedVersions]
        var anchors: [String: Bool] = [:]
        for (k, v) in a.anchors { anchors[k] = v }
        app["anchors"] = anchors
        // The chat list is informational (Muse hides it in a narrow window); only listing chats needs it (the bridge never switches chats).
        app["failed_anchors"] = a.anchors.filter { !$0.1 && !SendAnchors.switchingOnly.contains($0.0) }.map(\.0)
        if let w = a.windowWidth, let h = a.windowHeight { app["window"] = ["width": w, "height": h] }
        var rules: [String: Any] = ["channel": f.rulesChannel, "source": a.rulesSource as Any? ?? NSNull(),
                                    "revision": a.rulesRevision as Any? ?? NSNull(), "key_id": a.rulesKeyId as Any? ?? NSNull()]
        if let n = a.rulesNote { rules["note"] = n }
        var lock: [String: Any] = ["held": f.lock.held]
        if let p = f.lock.pid { lock["pid"] = Int(p) }
        if let al = f.lock.alive { lock["alive"] = al }
        if let ag = f.lock.ageSeconds { lock["age_seconds"] = ag }
        return ["bot": f.bot, "binary_version": f.binaryVersion, "app": app, "rules": rules, "keyset": keysetFields(f.keyset),
                "lock": lock, "last_sends": sends(f), "report": text(f)]
    }

    public static func text(_ f: DoctorFacts) -> String {
        let a = f.app
        var l = ["claude-bot-bridge doctor", "bot \(f.bot), binary \(f.binaryVersion)"]
        if !a.running { l.append("app: not running") }
        else {
            let size = a.windowWidth.flatMap { w in a.windowHeight.map { " window \(w)x\($0)" } } ?? ""
            l.append("app: running, Accessibility \(a.axTrusted ? "granted" : "NOT granted"), version \(a.versionShort ?? "?") (build \(a.versionBuild ?? "?")), layout \(a.layout ?? "?")\(size)")
            l.append("profile: \(a.profile ?? "none") (version_check \(a.versionCheck ?? "?")), verified versions: \(a.verifiedVersions.joined(separator: ", "))")
            l.append("anchors: " + a.anchors.map { $0.1 ? "ok \($0.0)" : SendAnchors.switchingOnly.contains($0.0) ? "not shown \($0.0) (only needed to list chats)" : "MISSING \($0.0)" }.joined(separator: ", "))
        }
        let key = a.rulesKeyId.map { ", key_id \($0)" } ?? ""
        l.append("rules: source \(a.rulesSource ?? "?"), revision \(a.rulesRevision.map(String.init) ?? "?")\(key), channel \(f.rulesChannel)\(a.rulesNote.map { ", note \($0)" } ?? "")")
        l.append("keyset \(keysetLine(f.keyset))")
        l.append("lock: " + (f.lock.held ? "held by pid \(f.lock.pid.map(String.init) ?? "?") (\(f.lock.alive == false ? "gone" : "running")), \(f.lock.ageSeconds ?? 0) s old" : "free"))
        let s = sends(f)
        l.append("last sends: " + (s.isEmpty ? "none" : s.map { "\($0["at"]!) \($0["outcome"]!)" }.joined(separator: "; ")))
        return l.joined(separator: "\n")
    }

    static func keysetLine(_ s: KeysetState) -> String {
        func keys(_ k: Keyset) -> String { k.keys.map { "\($0.id) (\($0.use))" }.joined(separator: ", ") }
        switch s {
        case .absent: return "absent (no keyset known: no signed update is trusted)"
        case .invalid(let why): return "invalid (\(why))"
        case .expired(let k): return "expired \(iso(k.notAfter)) (keyset expired: no signed update is trusted until a newer keyset is published), keys \(keys(k))"
        case .valid(let k, let src): return "valid (\(src)), issued \(iso(k.issuedAt)), expires \(iso(k.notAfter)), keys \(keys(k)), revoked \(k.revoked.count)"
        }
    }
}
