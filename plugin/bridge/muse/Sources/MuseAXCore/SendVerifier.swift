import Foundation

/// What the verification step needs from the live app (the app itself in production, a fake in tests).
public protocol ChatReader {
    func currentChat() -> String?
    func messages() -> [Message]
}

public struct VerifyResult {
    public let sent: Bool
    public let messages: [Message]
    /// "chat_changed" when the open chat is no longer the requested one, so the arrival cannot be attributed.
    public let note: String?
    public let openChat: String?
}

public enum SendVerifier {
    /// Polls for the text to show up as a NEW last user message that IS the text. A message only counts when the
    /// open chat is still `chat` before and after it was read: the same words in another chat prove nothing.
    public static func verify(_ r: ChatReader, chat: String, text: String, before: [Message],
                              polls: Int = 12, sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) -> VerifyResult {
        var msgs = before
        for _ in 0..<polls {
            sleep(0.5)
            let open = r.currentChat()
            guard open == chat else { return VerifyResult(sent: false, messages: msgs, note: "chat_changed", openChat: open) }
            msgs = r.messages()
            let newer = MessageParser.userCount(msgs) > MessageParser.userCount(before) || !MessageParser.lastUserEquals(text, in: before)
            guard MessageParser.lastUserEquals(text, in: msgs) && newer else { continue }
            let after = r.currentChat()
            if after == chat { return VerifyResult(sent: true, messages: msgs, note: nil, openChat: after) }
            return VerifyResult(sent: false, messages: msgs, note: "chat_changed", openChat: after)
        }
        return VerifyResult(sent: false, messages: msgs, note: nil, openChat: r.currentChat())
    }
}
