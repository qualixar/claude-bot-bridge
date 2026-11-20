import Testing
import Foundation
@testable import MuseAXCore

/// The bridge never presses a chat-list button, on any layout (see ChatSwitchPolicy).
@Suite struct ChatSwitchPolicyTests {
    @Test func theOpenChatIsAccepted() {
        #expect(ChatSwitchPolicy.refusal(requested: "Work", current: "Work") == nil)
        #expect(ChatSwitchPolicy.refusal(requested: "Main chat", current: "Main chat", listed: ["Main chat", "Work"]) == nil)
    }
    @Test func anyOtherChatIsRefusedWithChatSwitchUnsupportedOnEveryLayout() {
        #expect(ChatSwitchPolicy.refusal(requested: "Other", current: "Work") == .chatSwitchUnsupported("Other"))                              // switcher or unknown: no list
        #expect(ChatSwitchPolicy.refusal(requested: "Other", current: "Work", listed: ["Main chat", "Work", "Other"]) == .chatSwitchUnsupported("Other"))   // sidebar: the chat exists, still not pressed
        #expect(ChatSwitchPolicy.refusal(requested: "Nowhere", current: "Work", listed: ["Work"]) == .chatSwitchUnsupported("Nowhere"))
        #expect(ChatSwitchPolicy.refusal(requested: "Work", current: nil) == .chatSwitchUnsupported("Work"))
    }
    @Test func matchingIsExactAndCaseSensitive() {
        for requested in ["work", "Work ", "Wor", "Work 2"] {
            #expect(ChatSwitchPolicy.refusal(requested: requested, current: "Work") == .chatSwitchUnsupported(requested))
        }
    }
    @Test func aNameThatAppearsTwiceInTheListIsAmbiguousEvenWhenItIsOpen() {
        #expect(ChatSwitchPolicy.refusal(requested: "Work", current: "Work", listed: ["Work", "Other", "Work"]) == .chatAmbiguous("Work"))
    }
    @Test func theRefusalCarriesTheStableCodeAndTheOpenItYourselfGuidance() throws {
        let e = try #require(ChatSwitchPolicy.refusal(requested: "Other", current: "Work"))
        #expect(e.code == "chat_switch_unsupported")
        #expect(e.message.contains("Open it in Muse yourself") && e.message.contains("\"Other\""))
    }
    @Test func creatingASideChatIsRefusedTheSameWay() {
        #expect(ChatSwitchPolicy.newSideChatRefusal.code == "chat_switch_unsupported")
        #expect(ChatSwitchPolicy.newSideChatRefusal.message.contains("New side chat"))
        #expect(ChatSwitchPolicy.newSideChatRefusal.message.contains("Open it in Muse yourself") || ChatSwitchPolicy.newSideChatRefusal.message.contains("Open or create"))
    }

    // A regression guard on the live code: no function that switches chats may press anything.
    @Test func theLiveOpenAndNewSideChatFunctionsNeverPerformAnAction() throws {
        let file = Fx.repoFile("plugin/bridge/muse/Sources/muse-ax/Muse.swift")
        guard FileManager.default.fileExists(atPath: file.path) else {
            #expect(ProcessInfo.processInfo.environment["CBB_REQUIRE_REPO_FILES"] != "1", "Muse.swift is missing")
            return
        }
        let src = try String(contentsOf: file, encoding: .utf8)
        func body(of signature: String) throws -> String {
            let start = try #require(src.range(of: signature), "\(signature) not found")
            let rest = src[start.upperBound...]
            let end = rest.range(of: "\n\n")?.lowerBound ?? rest.endIndex   // functions are separated by a blank line
            return String(rest[..<end])
        }
        for sig in ["func open(_ name: String) throws {", "func newSideChat() throws"] {
            let b = try body(of: sig)
            #expect(!b.contains("PerformAction") && !b.contains("kAXPressAction") && !b.contains("chatButtons().first"), "\(sig) must not press anything")
        }
        // The only press left in the file is the cancel button of a file sheet.
        let presses = src.components(separatedBy: "AXUIElementPerformAction").count - 1
        #expect(presses == 1, "found \(presses) AXUIElementPerformAction calls in Muse.swift; only dismissSheet may press")
    }
}
