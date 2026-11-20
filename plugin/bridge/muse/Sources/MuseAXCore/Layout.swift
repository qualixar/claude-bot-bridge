/// How this Muse version exposes the list of chats.
public enum ChatListLayout: String, Equatable {
    /// Muse 12.x: a "Side chats" sidebar with one button per chat, plus "Main chat" and "New side chat".
    case sidebar = "sidebar"
    /// Muse 13.x: no sidebar; one "Chats ... Open chat and side chats" button opens the list.
    case chatSwitcher = "chat_switcher"
    case unknown = "unknown"
}
