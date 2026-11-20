import ApplicationServices
import AppKit
import MuseAXCore

/// Read-only and navigation operations on the Muse UI, all driven by the active profile.
extension MuseApp {
    func chatButtons() -> [AXUIElement] {
        guard let sb = find("sidebar") else { return [] }
        return findAll("chat_button", under: sb)
    }

    var layout: ChatListLayout { profile.detectLayout { find($0) != nil } }

    /// The chat list disappears when the window is narrow; say so instead of blaming a Meta UI change.
    func chatListHidden() -> MuseError {
        let width = window.map { Int(AX.frame($0).width) }.flatMap { $0 > 0 ? $0 : nil }
        return .chatListHidden(width: width)
    }

    /// Sidebar layout: every chat (only read, never pressed). Chat-switcher layout: only the open chat (the list sits behind a
    /// button this bridge does not press).
    func chatNames() throws -> [String] {
        switch layout {
        case .sidebar: return chatButtons().map(AX.title)
        case .chatSwitcher: return currentChat().map { [$0] } ?? []
        case .unknown: throw chatListHidden()
        }
    }

    func composerTitle() -> String? { composer().map(AX.title) }

    func currentChat() -> String? {
        composerTitle().flatMap { ChatNames.currentFromComposer($0, rules: profile.composer) }
    }

    /// Top-level children of "Chat messages" -> their static-text values.
    func messageItems() -> [[String]] {
        guard let g = messagesGroup() else { return [] }
        return AX.children(g).map { item in
            findAll("static_text", under: item).map { s in
                let v = AX.value(s); return v.isEmpty ? AX.title(s) : v
            }
        }
    }

    func messages() -> [Message] { MessageParser.parse(messageItems(), rules: profile.messages) }

    /// Succeeds only when `name` is the chat that is already open. The bridge never presses a chat-list button, on any layout:
    /// any other chat is refused with chat_switch_unsupported (see ChatSwitchPolicy).
    func open(_ name: String) throws {
        let listed = layout == .sidebar ? chatButtons().map(AX.title) : nil
        if let refusal = ChatSwitchPolicy.refusal(requested: name, current: currentChat(), listed: listed) { throw refusal }
    }

    /// Creating a side chat means pressing a chat-list button, which the bridge never does.
    func newSideChat() throws { throw ChatSwitchPolicy.newSideChatRefusal }

    /// Cancels an accidental file sheet. Returns true if one was closed.
    func dismissSheet() -> Bool {
        guard let s = openSheet() else { return false }
        if let c = find("sheet_cancel", under: s) {
            AXUIElementPerformAction(c, kAXPressAction as CFString)
            usleep(600_000)
        }
        return true
    }

    /// name -> found for the anchors a profile needs to be usable (probe mode and `send` use this).
    func probeAnchors() -> [(String, Bool)] {
        let lay = layout
        return [("chat_list", lay != .unknown)] + profile.requiredElements(layout: lay).map { ($0, find($0) != nil) }
    }

    /// Every anchor the bridge depends on, including the transient ones (window present, no sheet open).
    func anchors() -> [(String, Bool)] {
        let absent = profile.anchors.absent.keys.sorted().map { name in
            (name, profile.anchors.absent[name].flatMap { windowChild($0) } == nil)
        }
        return [("window", window != nil)] + probeAnchors() + absent
    }
}
