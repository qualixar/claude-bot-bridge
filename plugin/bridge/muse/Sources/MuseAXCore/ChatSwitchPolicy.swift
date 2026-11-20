import Foundation

/// The bridge never switches chats. It does not press a button of the chat list on any layout (the 12.x sidebar, the 13.x
/// "Chats" switcher or a layout it does not know), and it does not press "New side chat" either: which controls those are
/// is guessed from titles by a denylist, and a wrong guess would click something the user did not mean. Only the chat that
/// is already open can be read or sent to; for any other one the caller is told to open it in Muse.
public enum ChatSwitchPolicy {
    /// nil when `requested` is the chat that is open right now (exact, case-sensitive); else the refusal to return.
    /// `listed` is the chat list when the layout shows one (read-only, never pressed): a name that appears twice cannot be
    /// told apart from its twin, so it is refused as ambiguous instead of guessing which one is open.
    public static func refusal(requested: String, current: String?, listed: [String]? = nil) -> MuseError? {
        if let listed = listed, listed.filter({ $0 == requested }).count > 1 { return .chatAmbiguous(requested) }
        if let c = current, c == requested { return nil }
        return .chatSwitchUnsupported(requested)
    }

    /// Creating a side chat is a button press in the chat list: always refused.
    public static let newSideChatRefusal = MuseError.chatSwitchUnsupported("New side chat")
}
