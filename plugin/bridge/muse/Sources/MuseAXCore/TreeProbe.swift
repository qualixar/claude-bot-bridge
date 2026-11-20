import Foundation

/// Evaluates a profile against a recorded accessibility tree: the same matchers, layout detection, anchors, chat
/// names and message parsing that the live helper applies to the running app. Used to replay recorded trees against
/// every profile in the rules (a rules change is checked before it ships) and by `doctor` for the draft profile.
public struct TreeProbe {
    public let root: TreeNode
    public let profile: Profile

    public init(root: TreeNode, profile: Profile) { self.root = root; self.profile = profile }

    private func matches(_ n: TreeNode, _ m: ElementMatcher) -> Bool {
        m.matches(role: n.role, title: { n.effectiveTitle }, childRoles: { n.children.map(\.role) })
    }

    /// Depth-first through the shared walker (no recursion, capped), skipping the menu bar like the live walk.
    private func walk(_ n: TreeNode, _ visit: (TreeNode) -> Bool) {
        TreeWalk.walk(root: n, children: { $0.children }, skip: { $0.role == "AXMenuBar" }, visit: visit)
    }

    public func find(_ name: String, under node: TreeNode? = nil) -> TreeNode? {
        guard let m = profile.elements[name] else { return nil }
        var hit: TreeNode?
        walk(node ?? root) { if matches($0, m) { hit = $0; return true }; return false }
        return hit
    }

    public func findAll(_ name: String, under node: TreeNode) -> [TreeNode] {
        guard let m = profile.elements[name] else { return [] }
        var out: [TreeNode] = []
        walk(node) { if matches($0, m) { out.append($0) }; return false }
        return out
    }

    public var window: TreeNode? { root.children.first { $0.role == "AXWindow" } }

    func windowChild(_ name: String) -> TreeNode? {
        guard let w = window, let m = profile.elements[name] else { return nil }
        return w.children.first { matches($0, m) }
    }

    public func layout() -> ChatListLayout { profile.detectLayout { find($0) != nil } }

    public func chatNames() -> [String] {
        switch layout() {
        case .sidebar: return find("sidebar").map { findAll("chat_button", under: $0).map(\.effectiveTitle) } ?? []
        case .chatSwitcher: return currentChat().map { [$0] } ?? []
        case .unknown: return []
        }
    }

    public func currentChat() -> String? {
        find("composer").flatMap { ChatNames.currentFromComposer($0.effectiveTitle, rules: profile.composer) }
    }

    public func messages() -> [Message] {
        guard let g = find("chat_messages_group") else { return [] }
        let items = g.children.map { item in
            findAll("static_text", under: item).map { $0.effectiveValue.isEmpty ? $0.effectiveTitle : $0.effectiveValue }
        }
        return MessageParser.parse(items, rules: profile.messages)
    }

    /// The anchors needed to use this profile (the chat list is informational, see SendAnchors).
    public func probeAnchors() -> [(String, Bool)] {
        let l = layout()
        return [("chat_list", l != .unknown)] + profile.requiredElements(layout: l).map { ($0, find($0) != nil) }
    }

    /// Same list and order as the live helper's `anchors()`: window, probe anchors, then the transient "absent" ones.
    public func anchors() -> [(String, Bool)] {
        let absent = profile.anchors.absent.keys.sorted().map { name in
            (name, profile.anchors.absent[name].flatMap { windowChild($0) } == nil)
        }
        return [("window", window != nil)] + probeAnchors() + absent
    }

    /// Names of the anchors that must hold for the profile to be usable for typing into the open chat.
    public func missingForTyping() -> [String] {
        SendAnchors.forTypingIntoOpenChat(anchors()).filter { !$0.1 }.map(\.0)
    }
}
