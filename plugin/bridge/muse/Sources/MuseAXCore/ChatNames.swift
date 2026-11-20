import Foundation

public enum ChatNames {
    /// Exact (case-sensitive) match; never fuzzy. Two buttons with the same name are refused: the bridge cannot tell
    /// which chat is meant, and the 12.x `chat_button` rule is a denylist (see rules/README.md).
    public static func resolve(_ name: String, in names: [String]) throws -> String {
        let hits = names.filter { $0 == name }.count
        guard hits > 0 else { throw MuseError.chatNotFound(name) }
        guard hits == 1 else { throw MuseError.chatAmbiguous(name) }
        return name
    }

    /// Composer title looks like "Message in <chat> Attach file ... Send".
    public static func chatFromComposerTitle(_ t: String, rules: ComposerRules) -> String? {
        let p = rules.named.prefix
        guard t.hasPrefix(p), let r = t.range(of: rules.named.terminator) else { return nil }
        let start = t.index(t.startIndex, offsetBy: p.count)
        guard start <= r.lowerBound else { return nil }
        let n = String(t[start..<r.lowerBound])
        return n.isEmpty ? nil : n
    }

    /// The chat the composer belongs to. Muse titles the Main chat composer without a chat name
    /// ("Message Attach file ... Send"); side chats read "Message in <name> Attach ...".
    public static func currentFromComposer(_ t: String, rules: ComposerRules) -> String? {
        if let c = chatFromComposerTitle(t, rules: rules) { return c }
        return rules.unnamedTitle.matches(t) ? rules.mainChatName : nil
    }

    /// True only when the open composer belongs to exactly `name` (a prefix of a longer chat name is a different chat).
    public static func composerMatches(title: String, chat name: String, rules: ComposerRules) -> Bool {
        if let c = chatFromComposerTitle(title, rules: rules) { return c == name }
        return name == rules.mainChatName
    }

    /// Idle = the trailing "Send" is present; while Muse generates it turns into a stop control.
    public static func composerIdle(title: String, rules: ComposerRules) -> Bool { title.hasSuffix(rules.idleSuffix) }
}
