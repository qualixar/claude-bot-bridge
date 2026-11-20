import Foundation
import CoreGraphics
import MuseAXCore

extension MuseApp: ChatReader {}

/// Seconds since the user last touched the keyboard or mouse (combined session state, all relevant event types).
enum UserInput {
    static func secondsSinceLast() -> TimeInterval {
        let types: [CGEventType] = [.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown, .leftMouseDragged, .scrollWheel]
        return types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? .infinity
    }
}

extension MuseDriver {
    /// Refuses (`ui_unavailable`) when neither a profile for this Muse version nor probe mode fits the live UI,
    /// so Claude can hand the task over through the board instead of typing blind. Every attempt, successful or
    /// refused, is journaled (hash and outcome, never the text) in ~/.claude-bot-bridge/sends.jsonl.
    func send(chat: String, text: String, dryRun: Bool) throws -> [String: Any] {
        let home = RulesStore.home()
        func journal(_ outcome: String) throws { try SendJournal.append(.init(chat: chat, text: text, outcome: outcome), home: home) }
        do {
            var result = try Commands.locked { try Self.sendLocked(chat, text, dryRun: dryRun) }
            let outcome = result["dry_run"] as? Bool == true ? "dry_run_ok"
                : result["sent"] as? Bool == true ? "sent" : (result["note"] as? String ?? "unverified")
            do { try journal(outcome) } catch { result["journal_warning"] = "the send journal could not be written: \(error)" }
            return result
        } catch let e as MuseError {
            try? journal(e.code)   // the original error is what the caller needs; a journal failure must not replace it
            throw e
        }
    }

    private static func sendLocked(_ chat: String, _ text: String, dryRun: Bool) throws -> [String: Any] {
        try SendRules.validate(text)
        guard MuseApp.running() != nil else { throw MuseError.notRunning }
        try IdleGuard.check(secondsSinceInput: UserInput.secondsSinceLast(), threshold: IdleGuard.threshold(env: ProcessInfo.processInfo.environment),
                            now: Date(), posted: PostedEvents.read(home: RulesStore.home()))
        let s = try MuseSession.open(forSending: true)
        guard s.selection.kind != .none else {
            throw MuseError.uiUnavailable(version: s.version.short, failed: s.selection.failedAnchors)
        }
        let m = s.muse
        try SendRules.preflight(running: true, sheetOpen: m.openSheet() != nil, composerFound: true)
        try m.open(chat)
        try SendRules.preflight(running: true, sheetOpen: m.openSheet() != nil, composerFound: m.composer() != nil)
        guard m.composer() != nil else { throw MuseError.composerNotFound }
        guard m.composerIdle() else { throw MuseError.inputFailed("Muse is still answering in this chat; nothing was typed.") }
        let before = m.messages()
        try Typist.send(chat: chat, text: text, dryRun: dryRun, muse: m)
        let sheet = m.openSheet() != nil
        if sheet { _ = m.dismissSheet() }
        var out: [String: Any] = ["chat": chat, "sheet_opened": sheet, "version_check": s.versionCheck, "profile": s.selection.profile.id]
        if dryRun {
            // Nothing was sent: every check passed, the composer held the text, and it was cleared again.
            out.merge(["sent": false, "dry_run": true, "would_send": !sheet, "last_user": NSNull()]) { $1 }
            return out
        }
        let v = SendVerifier.verify(m, chat: chat, text: text, before: before)
        out["sent"] = v.sent && !sheet
        out["last_user"] = MessageParser.last(1, of: v.messages.filter { $0.role == "user" }).first?.text as Any? ?? NSNull()
        if let note = v.note { out["note"] = note; out["open_chat"] = v.openChat as Any? ?? NSNull() }
        return out
    }
}
