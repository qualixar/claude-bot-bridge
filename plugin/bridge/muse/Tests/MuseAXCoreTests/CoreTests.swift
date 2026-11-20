import Testing
@testable import MuseAXCore

@Suite struct SendRulesTests {
    @Test func acceptsPrefixedText() throws { try SendRules.validate("[Claude Code] hello") }
    @Test func refusesMissingPrefix() { #expect(throws: MuseError.self) { try SendRules.validate("hello") } }
    @Test func refusesPrefixOnly() { #expect(throws: MuseError.self) { try SendRules.validate("[Claude Code]") } }
    @Test func refusesTooLong() {
        #expect(throws: MuseError.self) { try SendRules.validate("[Claude Code] " + String(repeating: "a", count: 490)) }
    }
    @Test func allowsExactly500() throws {
        try SendRules.validate("[Claude Code] " + String(repeating: "a", count: 486))
    }
    @Test func refusesNewlines() { #expect(throws: MuseError.self) { try SendRules.validate("[Claude Code] a\nb") } }
    @Test func preflightOrder() {
        #expect(throws: MuseError.notRunning) { try SendRules.preflight(running: false, sheetOpen: false, composerFound: true) }
        #expect(throws: MuseError.sheetOpen) { try SendRules.preflight(running: true, sheetOpen: true, composerFound: true) }
        #expect(throws: MuseError.composerNotFound) { try SendRules.preflight(running: true, sheetOpen: false, composerFound: false) }
        #expect(throws: Never.self) { try SendRules.preflight(running: true, sheetOpen: false, composerFound: true) }
    }
}

@Suite struct MessageParserTests {
    @Test func separatorStampsFollowingMessages() {
        let m = MessageParser.parse([["1:23"], ["You:", "ping"], ["pong"]], rules: Fx.p12.messages)
        #expect(m == [Message(role: "user", text: "ping", time: "1:23"), Message(role: "assistant", text: "pong", time: "1:23")])
    }
    @Test func inlineYouMarker() {
        #expect(MessageParser.parse([["You: hi"]], rules: Fx.p12.messages) == [Message(role: "user", text: "hi")])
    }
    @Test func mergesConsecutiveAssistantItems() {
        let m = MessageParser.parse([["You:", "q"], ["a1"], [], ["a2", "a3"]], rules: Fx.p12.messages)
        #expect(m.count == 2 && m[1].text == "a1\na2\na3")
    }
    @Test func timeSeparatorBreaksMerge() {
        #expect(MessageParser.parse([["a"], ["2:00"], ["b"]], rules: Fx.p12.messages).count == 2)
    }
    @Test func lastAndVerification() {
        let m = MessageParser.parse([["You:", "[Claude Code] x"], ["ok"]], rules: Fx.p12.messages)
        #expect(MessageParser.lastUserContains("[Claude Code] x", in: m))
        #expect(!MessageParser.lastUserContains("other", in: m))
        #expect(MessageParser.last(1, of: m).count == 1)
        #expect(MessageParser.last(0, of: m).isEmpty)
        #expect(MessageParser.replyAfterLastUser(m)?.text == "ok")
    }
    @Test func timeDetection() {
        #expect(MessageParser.looksLikeTime("1:23", rules: Fx.p12.messages) && MessageParser.looksLikeTime("10:42 PM", rules: Fx.p12.messages))
        #expect(!MessageParser.looksLikeTime("ratio 1:23 ok", rules: Fx.p12.messages))
    }
}

@Suite struct ReplyWatcherTests {
    let user = Message(role: "user", text: "q")
    @Test func waitsForNewStableReply() {
        var w = ReplyWatcher(baseline: Message(role: "assistant", text: "old"))
        #expect(w.feed([user, Message(role: "assistant", text: "old")]) == nil)
        #expect(w.feed([user, Message(role: "assistant", text: "new par")]) == nil)
        #expect(w.feed([user, Message(role: "assistant", text: "new part two")]) == nil)
        #expect(w.feed([user, Message(role: "assistant", text: "new part two")])?.text == "new part two")
    }
    @Test func noBaselineAcceptsFirstStableReply() {
        var w = ReplyWatcher(baseline: nil, stableReads: 1)
        #expect(w.feed([user]) == nil)
        #expect(w.feed([user, Message(role: "assistant", text: "hi")])?.text == "hi")
    }
}

@Suite struct ChatNamesTests {
    @Test func exactMatchOnly() throws {
        #expect(try ChatNames.resolve("Main chat", in: ["Main chat", "X"]) == "Main chat")
        #expect(throws: MuseError.chatNotFound("main chat")) { try ChatNames.resolve("main chat", in: ["Main chat"]) }
        #expect(throws: MuseError.chatAmbiguous("Work")) { try ChatNames.resolve("Work", in: ["Work", "Other", "Work"]) }
    }
    @Test func composerTitleParsing() {
        let c = Fx.p12.composer
        let t = "Message in Check assistant availability Attach files Send"
        #expect(ChatNames.chatFromComposerTitle(t, rules: c) == "Check assistant availability")
        #expect(ChatNames.composerMatches(title: t, chat: "Check assistant availability", rules: c))
        #expect(!ChatNames.composerMatches(title: t, chat: "Other", rules: c))
        #expect(ChatNames.composerMatches(title: "Message Muse Send", chat: "Main chat", rules: c))
        #expect(!ChatNames.composerMatches(title: t, chat: "Check assistant availability and more", rules: c))
    }
    @Test func idleDependsOnTheTrailingSend() {
        #expect(ChatNames.composerIdle(title: "Message Attach file Send", rules: Fx.p13.composer))
        #expect(!ChatNames.composerIdle(title: "Message Attach file Stop", rules: Fx.p13.composer))
    }
}

@Suite struct ArgParserTests {
    @Test func parsesAll() throws {
        #expect(try ArgParser.parse(["status"]) == .status)
        #expect(try ArgParser.parse(["open", "A b"]) == .open(name: "A b"))
        #expect(try ArgParser.parse(["read", "--last", "5", "--chat", "X"]) == .read(chat: "X", last: 5))
        #expect(try ArgParser.parse(["send", "--chat", "X", "[Claude Code] hi"]) == .send(chat: "X", text: "[Claude Code] hi", dryRun: false))
        #expect(try ArgParser.parse(["send", "--dry-run", "--chat", "X", "[Claude Code] hi"]) == .send(chat: "X", text: "[Claude Code] hi", dryRun: true))
        #expect(try ArgParser.parse(["history"]) == .history(last: nil))
        #expect(try ArgParser.parse(["history", "--last", "5"]) == .history(last: 5))
        #expect(try ArgParser.parse(["wait-reply", "--chat", "X"]) == .waitReply(chat: "X", timeout: 120))
        #expect(try ArgParser.parse(["wait-reply", "--chat", "X", "--timeout", "30"]) == .waitReply(chat: "X", timeout: 30))
    }
    @Test func parsesMaintenanceCommands() throws {
        #expect(try ArgParser.parse(["version"]) == .version)
        #expect(try ArgParser.parse(["rules", "update"]) == .rulesUpdate)
        #expect(try ArgParser.parse(["rules", "show"]) == .rulesShow)
        #expect(try ArgParser.parse(["canary"]) == .canary(notify: true))
        #expect(try ArgParser.parse(["canary", "--no-notify"]) == .canary(notify: false))
    }
    @Test func rejectsBadInput() {
        for bad in [[], ["nope"], ["open"], ["send", "x"], ["read", "--last", "0"], ["read", "--last", "abc"],
                    ["wait-reply", "--chat", "X", "--timeout", "0"], ["status", "extra"], ["read", "--chat"],
                    ["history", "--last", "0"], ["history", "x"], ["rules"], ["rules", "nope"], ["rules", "update", "x"], ["version", "x"], ["canary", "--bogus"]] {
            #expect(throws: MuseError.self) { try ArgParser.parse(bad) }
        }
    }
}

@Suite struct JSONTests {
    @Test func failureShape() {
        let s = JSONOut.failure(.sheetOpen)
        #expect(s.contains("\"ok\":false") && s.contains("sheet_open"))
    }
    @Test func successShape() { #expect(JSONOut.success(["a": 1]) == #"{"a":1,"ok":true}"#) }
}

@Suite struct Muse13LayoutTests {
    @Test func switchUnsupportedError() {
        let e = MuseError.chatSwitchUnsupported("Work")
        #expect(e.code == "chat_switch_unsupported")
        #expect(e.message.contains("Work"))
        #expect(e.message.contains("never presses") && e.message.contains("Open it in Muse yourself"))
    }
}

@Suite struct Muse13MessageTests {
    // Strings below are copied from the Muse 13.1 accessibility tree.
    @Test func userAndAssistantPrefixes() {
        let m = MessageParser.parse([
            ["Assistant message: Done. And first, the direct answer"],
            ["User message: You need to stop creating videos"],
            ["Assistant message: The one thing still running"],
        ], rules: Fx.p13.messages)
        #expect(m == [
            Message(role: "assistant", text: "Done. And first, the direct answer"),
            Message(role: "user", text: "You need to stop creating videos"),
            Message(role: "assistant", text: "The one thing still running"),
        ])
    }
    @Test func dateTimeSeparatorsStampMessages() {
        let m = MessageParser.parse([["15 Nov at 14:30"], ["Assistant message: hi"], ["16 Nov at 8:12"], ["User message: yo"], ["0:01"], ["Assistant message: ok"]], rules: Fx.p13.messages)
        #expect(m[0] == Message(role: "assistant", text: "hi", time: "15 Nov at 14:30"))
        #expect(m[1] == Message(role: "user", text: "yo", time: "16 Nov at 8:12"))
        #expect(m[2] == Message(role: "assistant", text: "ok", time: "0:01"))
    }
    @Test func timeShapes() {
        for t in ["1:23", "0:01", "9:05 PM", "15 Nov at 14:30", "Today at 9:16", "Yesterday at 8:12 AM", "3 December at 7:00"] {
            #expect(MessageParser.looksLikeTime(t, rules: Fx.p13.messages), "\(t)")
        }
        for t in ["Assistant message: 5:00", "hello", "15 Nov", "Run 44386186742"] {
            #expect(!MessageParser.looksLikeTime(t, rules: Fx.p13.messages), "\(t)")
        }
    }
    @Test func legacyYouMarkerStillWorks() {
        #expect(MessageParser.parse([["You:", "ping"]], rules: Fx.p13.messages) == [Message(role: "user", text: "ping")])
    }
    @Test func userMessageLookupAfterSend() {
        let m = MessageParser.parse([["User message: [Claude Code] hello"]], rules: Fx.p13.messages)
        #expect(MessageParser.lastUserContains("[Claude Code] hello", in: m))
    }
}

@Suite struct ComposerChatTests {
    @Test func mainChatHasNoChatInTitle() {
        #expect(ChatNames.currentFromComposer("Message Attach file Dictate a message Send", rules: Fx.p13.composer) == "Main chat")
    }
    @Test func sideChatNamed() {
        #expect(ChatNames.currentFromComposer("Message in Work Attach file Dictate a message Send", rules: Fx.p13.composer) == "Work")
    }
    @Test func notAComposer() { #expect(ChatNames.currentFromComposer("Search", rules: Fx.p13.composer) == nil) }
}


@Suite struct ChatListHiddenTests {
    @Test func narrowWindowGetsItsOwnCodeAndFix() {
        let e = MuseError.chatListHidden(width: 513)
        #expect(e.code == "chat_list_hidden")
        #expect(e.message.contains("513 px"))
        #expect(e.message.contains("Widen the Muse window"))
        #expect(!e.message.contains("Meta may have changed"))
    }
    @Test func unknownWidthStillActionable() {
        #expect(MuseError.chatListHidden(width: nil).message.contains("Widen the Muse window"))
    }
}

@Suite struct SendAnchorTests {
    @Test func chatListIsNotNeededToTypeIntoTheOpenChat() {
        let probe: [(String, Bool)] = [("chat_list", false), ("composer", true), ("chat_messages_group", true)]
        let kept = SendAnchors.forTypingIntoOpenChat(probe)
        #expect(kept.map { $0.0 } == ["composer", "chat_messages_group"])
        #expect(kept.allSatisfy { $0.1 })
    }
    @Test func otherMissingAnchorsStillFail() {
        let probe: [(String, Bool)] = [("chat_list", false), ("composer", false)]
        #expect(SendAnchors.forTypingIntoOpenChat(probe).contains { $0.0 == "composer" && !$0.1 })
    }
}

@Suite struct DoctorArgumentTests {
    @Test func parsesDoctorAndItsFlags() throws {
        #expect(try ArgParser.parse(["doctor"]) == .doctor(dump: nil, text: false))
        #expect(try ArgParser.parse(["doctor", "--text"]) == .doctor(dump: nil, text: true))
        #expect(try ArgParser.parse(["doctor", "--dump-tree"]) == .doctor(dump: .defaultPath, text: false))
        #expect(try ArgParser.parse(["doctor", "--dump-tree", "/tmp/t.json"]) == .doctor(dump: .path("/tmp/t.json"), text: false))
        #expect(try ArgParser.parse(["doctor", "--dump-tree", "--text"]) == .doctor(dump: .defaultPath, text: true))
        #expect(try ArgParser.parse(["doctor", "--text", "--dump-tree", "x.json"]) == .doctor(dump: .path("x.json"), text: true))
    }
    @Test func rejectsAnythingElse() {
        for bad in [["doctor", "extra"], ["doctor", "--dump-tree", "a", "--dump-tree", "b"], ["doctor", "--bogus"], ["doctor", "--dump-tree", ""]] {
            #expect(throws: MuseError.self) { try ArgParser.parse(bad) }
        }
    }
    @Test func theUsageMentionsDoctor() { #expect(ArgParser.usage.contains("doctor")) }
}
