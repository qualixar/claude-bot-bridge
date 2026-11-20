import Testing
import Foundation
@testable import MuseAXCore

@Suite struct TitleMatcherTests {
    @Test func allConditionsMustHold() {
        let m = TitleMatcher(equals: nil, prefix: "Message", suffix: nil, contains: " Attach", nonEmpty: nil, notIn: nil)
        #expect(m.matches("Message in X Attach file Send"))
        #expect(!m.matches("Message only"))
        #expect(!m.matches("Other Attach"))
    }
    @Test func equalsSuffixNotInNonEmpty() {
        #expect(TitleMatcher(equals: "A").matches("A") && !TitleMatcher(equals: "A").matches("a"))
        #expect(TitleMatcher(suffix: "Send").matches("x Send") && !TitleMatcher(suffix: "Send").matches("Send x"))
        let chat = TitleMatcher(nonEmpty: true, notIn: ["Search"])
        #expect(chat.matches("Main chat") && !chat.matches("") && !chat.matches("Search"))
    }
}

@Suite struct ElementMatcherTests {
    @Test func roleAndTitle() {
        let m = Fx.p13.elements["chat_messages_group"]!
        #expect(m.matches(role: "AXGroup", title: "Chat messages", childRoles: { [] }))
        #expect(!m.matches(role: "AXButton", title: "Chat messages", childRoles: { [] }))
        #expect(!m.matches(role: "AXGroup", title: "Other", childRoles: { [] }))
    }
    @Test func childRoleIsOnlyEvaluatedWhenNeeded() {
        let sidebar = Fx.p12.elements["sidebar"]!
        #expect(sidebar.needsChildren)
        #expect(sidebar.matches(role: "AXGroup", title: "Side chats", childRoles: { ["AXButton", "AXTextField"] }))
        #expect(!sidebar.matches(role: "AXGroup", title: "Side chats", childRoles: { ["AXButton"] }))
        #expect(!sidebar.matches(role: "AXGroup", title: "Side chats", childRoles: { [] }))
        var called = false
        #expect(!sidebar.matches(role: "AXButton", title: "Side chats", childRoles: { called = true; return [] }))
        #expect(!called)
    }
    @Test func realMuse13SwitcherTitles() {
        let m = Fx.p13.elements["switcher"]!
        #expect(m.matches(role: "AXButton", title: "Chats Unread chats Open chat and side chats", childRoles: { [] }))
        #expect(m.matches(role: "AXButton", title: "Chats Open chat and side chats", childRoles: { [] }))
        for t in ["Chat", "Chats", "Open chat and side chats", "Search", ""] {
            #expect(!m.matches(role: "AXButton", title: t, childRoles: { [] }), "\(t)")
        }
    }
    @Test func chatButtonsExcludeChrome() {
        let m = Fx.p12.elements["chat_button"]!
        for t in ["New side chat", "Side chats", "Channels", "Search", ""] {
            #expect(!m.matches(role: "AXButton", title: t, childRoles: { [] }), "\(t)")
        }
        #expect(m.matches(role: "AXButton", title: "Main chat", childRoles: { [] }))
    }
}
