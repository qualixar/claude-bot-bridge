import Foundation
import ApplicationServices
import MuseAXCore

/// The Meta Muse desktop app, driven through the macOS Accessibility API. This file, AX.swift, Muse.swift, Session.swift,
/// Send.swift, SendCommand.swift and TreeCapture.swift are the only places that know what Muse is.
struct MuseDriver: BotDriver {
    static let id = "muse"
    static let bundleID = "com.meta.endo"

    var id: String { Self.id }
    var bundleID: String { Self.bundleID }
    var rulesNamespace: String { Self.id }
    var builtinRules: RulesDocument { BuiltinRules.document }

    func selectProfile(version: String?, profiles: [Profile], verifyMatched: Bool, probe: (Profile) -> [(String, Bool)]) -> ProfileSelection? {
        ProfileSelector.select(version: version, profiles: profiles, verifyMatched: verifyMatched, probe: probe)
    }

    static func withApp(_ body: (MuseApp) throws -> [String: Any]) throws -> [String: Any] {
        try body(try MuseSession.open().muse)
    }

    func status() -> [String: Any] {
        let running = MuseApp.running() != nil
        let trusted = MuseApp.trusted()
        var out: [String: Any] = ["running": running, "ax_trusted": trusted]
        guard running, trusted, let s = try? MuseSession.open() else { out["anchors"] = [String: Bool](); return out }
        let report = SelftestReport(s.muse.anchors())
        out["anchors"] = report.checks
        if let visible = report.chatListVisible { out["chat_list_visible"] = visible }
        out["current_chat"] = s.muse.currentChat() as Any? ?? NSNull()
        out["all_anchors_found"] = report.failed.isEmpty
        out.merge(s.versionFields()) { $1 }
        return out
    }

    func chats() throws -> [String: Any] {
        try Self.withApp { ["chats": try $0.chatNames(), "current": $0.currentChat() as Any? ?? NSNull()] }
    }

    func open(chat: String) throws -> [String: Any] {
        try Commands.locked { try Self.withApp { try $0.open(chat); return ["opened": chat] } }
    }

    func newSideChat() throws -> [String: Any] {
        try Commands.locked { try Self.withApp { try $0.newSideChat(); return ["created": true, "current": $0.currentChat() as Any? ?? NSNull()] } }
    }

    /// Reading the open chat touches nothing; naming a chat presses its sidebar button, so that read takes the lock.
    func read(chat: String?, last: Int?) throws -> [String: Any] {
        chat == nil ? try Self.withApp { try Self.readChat($0, chat, last) } : try Commands.locked { try Self.withApp { try Self.readChat($0, chat, last) } }
    }

    private static func readChat(_ m: MuseApp, _ chat: String?, _ last: Int?) throws -> [String: Any] {
        if let c = chat { try m.open(c) }
        guard m.messagesGroup() != nil else { throw MuseError.anchorMissing("Chat messages group") }
        var msgs = m.messages()
        if let n = last { msgs = MessageParser.last(n, of: msgs) }
        return ["chat": m.currentChat() as Any? ?? NSNull(), "messages": JSONOut.messages(msgs)]
    }

    func selftest() throws -> [String: Any] {
        guard MuseApp.running() != nil else { throw MuseError.notRunning }
        let s = try MuseSession.open()
        let report = SelftestReport(s.muse.anchors())
        guard report.failed.isEmpty else {
            throw MuseError.anchorMissing("\(report.failed.joined(separator: ", ")) (Muse \(s.version.short ?? "?") build \(s.version.build ?? "?"), profile \(s.selection.profile.id), checks: \(JSONOut.line(["c": report.checks])))")
        }
        var out = s.versionFields()
        out["checks"] = report.checks
        // A narrow window hides the chat list: informational, not a failure. Switching chats checks it itself.
        if let visible = report.chatListVisible { out["chat_list_visible"] = visible }
        if report.chatListVisible != false { out["chats"] = try s.muse.chatNames().count }
        return out
    }

    /// Each poll opens the chat and reads it under the UI lock, then releases it while sleeping, so a long wait
    /// never keeps a send from running.
    func waitReply(chat: String, timeout: Double) throws -> [String: Any] {
        let m = try MuseSession.open().muse
        let reply = try ReplyWaiter.wait(timeout: timeout, interval: 1.5, now: Date.init, sleep: { Thread.sleep(forTimeInterval: $0) },
                                         snapshot: { try Commands.locked { try m.open(chat); return m.messages() } })
        return ["reply": JSONOut.messages([reply])[0], "waited": true]
    }

    func isRunning() -> Bool { MuseApp.running() != nil }

    func runningVersion() -> String? { MuseApp.running().flatMap { MuseSession.version(of: $0).short } }

    func diagnostics() -> AppDiagnostics {
        let rules = RulesStore.load(home: RulesStore.home(), bot: id, trust: LiveTrust.context(), builtin: builtinRules)
        var d = AppDiagnostics.notRunning
        d.rulesSource = rules.source; d.rulesRevision = rules.revision; d.rulesKeyId = rules.keyId; d.rulesNote = rules.note
        d.verifiedVersions = rules.document.profiles.flatMap(\.match.versions)
        d.axTrusted = MuseApp.trusted()
        guard let app = MuseApp.running() else { return d }
        d.running = true
        let v = MuseSession.version(of: app)
        d.versionShort = v.short; d.versionBuild = v.build
        guard d.axTrusted, let s = try? MuseSession.open() else { return d }
        d.profile = s.selection.profile.id; d.versionCheck = s.versionCheck
        d.layout = s.muse.layout.rawValue; d.anchors = s.muse.anchors()
        if let w = s.muse.window {
            let f = AX.frame(w)
            if f.width > 0 { d.windowWidth = Int(f.width); d.windowHeight = Int(f.height) }
        }
        return d
    }

    func dumpTree(to url: URL) throws -> TreeDumpResult {
        guard MuseApp.running() != nil else { throw MuseError.notRunning }
        let s = try MuseSession.open()
        let profile = s.selection.profile
        let snap = TreeCapture.snapshot(s.muse.ax, messages: profile.elements["chat_messages_group"])
        let (red, stats) = Redactor.redact(snap.root, profile: profile, salt: Redactor.newSalt())
        let doc = TreeDocument(museVersion: s.version.short, redacted: true, source: "muse-ax doctor --dump-tree", tree: red)
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys, .prettyPrinted]
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try AtomicFile.write(try enc.encode(doc), to: url)
        chmod(url.path, 0o600)
        let draft = DraftProfile.make(raw: snap.root, redacted: red, base: profile, idPrefix: id, version: s.version.short)
        return TreeDumpResult(path: url, nodes: stats.nodes, hashed: stats.hashed, dropped: stats.dropped, kept: stats.kept,
                              truncated: snap.truncated, draftProfile: draft.profile, notes: draft.notes)
    }
}
