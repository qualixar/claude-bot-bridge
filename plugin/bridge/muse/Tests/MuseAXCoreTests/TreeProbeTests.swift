import Testing
import Foundation
@testable import MuseAXCore

/// The tree evaluator mirrors what the live helper does with the accessibility tree, on data.
@Suite struct TreeProbeTests {
    @Test func aSidebarTreeIsReadAsASidebarLayout() {
        let p = TreeProbe(root: T.sidebarTree(), profile: Fx.p12)
        #expect(p.layout() == .sidebar)
        #expect(p.chatNames() == ["Main chat", "Project Phoenix", "Tax return 2026"])
        #expect(p.currentChat() == "Project Phoenix")
        #expect(p.anchors().allSatisfy { $0.1 })
        #expect(p.anchors().map(\.0) == ["window", "chat_list", "web_area", "chat_messages_group", "composer", "main_chat_button", "new_side_chat_button", "no_sheet_open"])
    }
    @Test func aSwitcherTreeOnlyKnowsTheOpenChat() {
        let p = TreeProbe(root: T.switcherTree(), profile: Fx.p13)
        #expect(p.layout() == .chatSwitcher)
        #expect(p.chatNames() == ["Project Phoenix"])
        #expect(p.currentChat() == "Project Phoenix")
        #expect(p.anchors().allSatisfy { $0.1 })
    }
    @Test func theMainChatComposerHasNoName() {
        #expect(TreeProbe(root: T.switcherTree(open: nil), profile: Fx.p13).currentChat() == "Main chat")
    }
    @Test func messagesFollowTheProfilesPrefixes() {
        let m = TreeProbe(root: T.switcherTree(), profile: Fx.p13).messages()
        #expect(m == [Message(role: "user", text: "private question about my salary"), Message(role: "assistant", text: "a reply")])
    }
    @Test func theMenuBarIsNeverWalked() {
        let tree = T.n("AXApplication", "Muse", [T.n("AXMenuBar", nil, [T.n("AXButton", "Main chat")])])
        #expect(TreeProbe(root: tree, profile: Fx.p12).find("main_chat_button") == nil)
    }
    @Test func anAnchorThatIsMissingIsReportedMissing() {
        let tree = T.n("AXApplication", "Muse", [T.n("AXWindow", "x", [T.n("AXWebArea", "")])])
        let p = TreeProbe(root: tree, profile: Fx.p13)
        #expect(p.layout() == .unknown)
        let missing = p.anchors().filter { !$0.1 }.map(\.0)
        #expect(missing.contains("composer") && missing.contains("chat_messages_group") && missing.contains("chat_list"))
    }
    @Test func anOpenSheetFailsTheNoSheetAnchor() {
        var tree = T.sidebarTree()
        tree.children[0].children.append(T.n("AXSheet", "Open"))
        #expect(TreeProbe(root: tree, profile: Fx.p12).anchors().first { $0.0 == "no_sheet_open" }?.1 == false)
    }
    @Test func theTitleFallsBackToTheDescriptionLikeTheLiveHelper() {
        let tree = T.n("AXApplication", nil, [T.n("AXWindow", nil, [T.n("AXWebArea", nil, [T.n("AXGroup", nil, desc: "Chat messages")])])])
        #expect(TreeProbe(root: tree, profile: Fx.p13).find("chat_messages_group") != nil)
    }
    @Test func nodesAndDepthAreCounted() {
        #expect(TreeProbe(root: T.switcherTree(), profile: Fx.p13).root.count == 10)
    }
}
