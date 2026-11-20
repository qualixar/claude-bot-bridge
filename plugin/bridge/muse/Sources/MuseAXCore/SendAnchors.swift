import Foundation

/// Which probed anchors matter for typing into the chat that is already open. The chat list only matters for
/// switching chats: Muse hides it in a narrow window (for example side by side with another app), and that
/// must not block a send to the open chat. Switching still checks the list itself.
public enum SendAnchors {
    public static let switchingOnly: Set<String> = ["chat_list"]

    public static func forTypingIntoOpenChat(_ probe: [(String, Bool)]) -> [(String, Bool)] {
        probe.filter { !switchingOnly.contains($0.0) }
    }
}
