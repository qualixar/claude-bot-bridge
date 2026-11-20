import Foundation

public struct Message: Codable, Equatable {
    public var role: String   // "user" | "assistant"
    public var text: String
    public var time: String?
    public init(role: String, text: String, time: String? = nil) {
        self.role = role; self.text = text; self.time = time
    }
}

public enum MessageParser {
    /// `items` = for each top-level child of the "Chat messages" group, the static-text
    /// values found inside it, in tree order.
    /// - A lone time ("1:23") is a centred separator: it stamps the messages that follow.
    /// - An item whose first text starts with a user prefix, or is a user marker ("You:"), is a user message.
    /// - Other items are assistant output; consecutive ones merge into one message.
    public static func parse(_ items: [[String]], rules: MessageRules) -> [Message] {
        var out: [Message] = []
        var stamp: String?
        var lastWasAssistant = false
        for raw in items {
            let texts = raw.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            if texts.isEmpty { continue }
            if texts.count == 1, looksLikeTime(texts[0], rules: rules) { stamp = texts[0]; lastWasAssistant = false; continue }
            if let p = rules.userPrefixes.first(where: { texts[0].hasPrefix($0) }) {
                var t = texts; t[0] = String(t[0].dropFirst(p.count))
                out.append(Message(role: "user", text: t.joined(separator: "\n"), time: stamp))
                lastWasAssistant = false
                continue
            }
            if let m = rules.userMarkers.first(where: { texts[0] == $0 || texts[0].hasPrefix($0 + " ") }) {
                let body = userBody(texts, marker: m)
                if !body.isEmpty { out.append(Message(role: "user", text: body, time: stamp)) }
                lastWasAssistant = false
                continue
            }
            var assistantTexts = texts
            if let p = rules.assistantPrefixes.first(where: { assistantTexts[0].hasPrefix($0) }) {
                assistantTexts[0] = String(assistantTexts[0].dropFirst(p.count))
            }
            let body = assistantTexts.joined(separator: "\n")
            if lastWasAssistant, !out.isEmpty {
                out[out.count - 1].text += "\n" + body
            } else {
                out.append(Message(role: "assistant", text: body, time: stamp))
            }
            lastWasAssistant = true
        }
        return out
    }

    static func userBody(_ texts: [String], marker: String) -> String {
        var t = texts
        if t[0] == marker { t.removeFirst() } else { t[0] = String(t[0].dropFirst(marker.count + 1)) }
        return t.joined(separator: "\n")
    }

    /// Separator lines such as "1:23", "9:05 PM" (12.x) or "15 Nov at 14:30" (13.x); the pattern comes from the rules.
    public static func looksLikeTime(_ s: String, rules: MessageRules) -> Bool {
        s.range(of: rules.timePattern, options: .regularExpression) != nil
    }

    public static func last(_ n: Int, of msgs: [Message]) -> [Message] {
        n <= 0 ? [] : Array(msgs.suffix(n))
    }

    public static func userCount(_ msgs: [Message]) -> Int { msgs.filter { $0.role == "user" }.count }

    /// True when the last user message contains `text`. Only a hint (e.g. "was there already such a message");
    /// arrival of a send is judged with `lastUserEquals`.
    public static func lastUserContains(_ text: String, in msgs: [Message]) -> Bool {
        guard let u = msgs.last(where: { $0.role == "user" }) else { return false }
        return normalize(u.text).contains(normalize(text))
    }

    /// True when the last user message IS `text` (after normalisation): stray text typed by someone else
    /// around the message makes this false.
    public static func lastUserEquals(_ text: String, in msgs: [Message]) -> Bool {
        guard let u = msgs.last(where: { $0.role == "user" }) else { return false }
        return sameText(u.text, text)
    }

    /// Whitespace-blind comparison, for judging what Muse DISPLAYED (it wraps lines and puts links on their own line).
    public static func sameText(_ a: String, _ b: String) -> Bool { normalize(a) == normalize(b) }

    /// The composer holds what was typed, so it is compared with whitespace collapsed (runs become one space, ends
    /// trimmed) and smart quotes straightened: "hellothere" is not "hello there".
    public static func collapse(_ s: String) -> String {
        let map: [Character: Character] = ["\u{201C}": "\"", "\u{201D}": "\"", "\u{2018}": "'", "\u{2019}": "'"]
        var out = ""
        var pendingSpace = false
        for ch in s {
            if ch.isWhitespace { pendingSpace = !out.isEmpty; continue }
            if pendingSpace { out.append(" "); pendingSpace = false }
            out.append(map[ch] ?? ch)
        }
        return out
    }

    public static func sameTextCollapsed(_ a: String, _ b: String) -> Bool { collapse(a) == collapse(b) }

    /// Muse renders "smart" quotes and splits links onto their own lines, so compare
    /// with straight quotes and no whitespace at all.
    public static func normalize(_ s: String) -> String {
        let map: [Character: Character] = ["\u{201C}": "\"", "\u{201D}": "\"", "\u{2018}": "'", "\u{2019}": "'"]
        return String(s.compactMap { ch -> Character? in
            if ch.isWhitespace { return nil }
            return map[ch] ?? ch
        })
    }

    /// Newest assistant message after the last user message, if any.
    public static func replyAfterLastUser(_ msgs: [Message]) -> Message? {
        guard let ui = msgs.lastIndex(where: { $0.role == "user" }) else { return nil }
        return msgs[(ui + 1)...].last(where: { $0.role == "assistant" })
    }
}

/// Decides when a reply is "new and finished": different from the baseline and unchanged
/// for `stableReads` consecutive polls (replies stream in).
public struct ReplyWatcher {
    public let baseline: Message?
    public let stableReads: Int
    private var candidate: String?
    private var streak = 0

    public init(baseline: Message?, stableReads: Int = 2) {
        self.baseline = baseline; self.stableReads = stableReads
    }

    /// Feed one poll's messages; returns the reply once complete.
    public mutating func feed(_ msgs: [Message]) -> Message? {
        guard let reply = MessageParser.replyAfterLastUser(msgs), reply.text != baseline?.text else {
            candidate = nil; streak = 0; return nil
        }
        if reply.text == candidate { streak += 1 } else { candidate = reply.text; streak = 1 }
        return streak >= stableReads ? reply : nil
    }
}
