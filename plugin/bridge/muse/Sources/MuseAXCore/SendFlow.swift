import Foundation

/// The side-effecting steps of a send. The live implementation drives Muse; tests inject a recording fake.
public protocol SendDriver {
    /// The chat whose composer is open right now (re-read from the live UI on every call).
    func currentChat() -> String?
    /// Tries to put keyboard focus into the composer text input without clicking. True only when verified.
    func focusViaAccessibility() -> Bool
    /// Throws `click_target_mismatch` unless the element under the click point is Muse's composer.
    func checkClickTarget() throws
    func click()
    /// The composer's current text; nil when it cannot be observed.
    func readComposer() -> String?
    func type(_ chunks: [[UInt16]])
    /// Select all + delete.
    func clearComposer()
    func pressReturn()
}

public enum SendFlow {
    /// Return is pressed only when the open chat is still `chat` and the composer holds exactly `text`
    /// (whitespace collapsed, quotes straightened). Anything else clears what was typed and refuses.
    /// With `dryRun` every check runs and the text is typed, but the composer is cleared instead of sent.
    public static func perform(chat: String, text: String, driver d: SendDriver, dryRun: Bool = false) throws {
        try requireChat(chat, d)
        if !d.focusViaAccessibility() {
            try d.checkClickTarget()
            d.click()
        }
        if let draft = d.readComposer(), !MessageParser.normalize(draft).isEmpty {
            throw MuseError.composerMismatch("the composer already holds a draft; it was left untouched.")
        }
        d.type(TextChunker.chunks(text))
        guard let seen = d.readComposer() else {
            d.clearComposer()
            throw MuseError.composerMismatch("the composer text could not be read back, so it could not be checked; the composer was cleared.")
        }
        guard MessageParser.sameTextCollapsed(seen, text) else {
            d.clearComposer()
            throw MuseError.composerMismatch("the composer holds different text than intended (something else was typed at the same time); it was cleared.")
        }
        do { try requireChat(chat, d) } catch { d.clearComposer(); throw error }
        if dryRun { d.clearComposer() } else { d.pressReturn() }
    }

    private static func requireChat(_ chat: String, _ d: SendDriver) throws {
        let now = d.currentChat()
        guard now == chat else {
            throw MuseError.chatChanged("expected \"\(chat)\" but the open chat is \(now.map { "\"\($0)\"" } ?? "unknown").")
        }
    }
}
