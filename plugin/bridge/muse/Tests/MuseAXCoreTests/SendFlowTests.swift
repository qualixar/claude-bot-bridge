import Testing
import Foundation
@testable import MuseAXCore

/// Records every call; behaviour is scripted per test. No Muse, no events, no clipboard.
final class FakeDriver: SendDriver {
    var log: [String] = []
    var chats: [String?]           // answer per currentChat() call; the last one repeats
    var axFocus = false
    var targetError: MuseError?
    var reads: [String?]           // answer per readComposer() call; the last one repeats
    var typed: [[UInt16]] = []
    init(chats: [String?] = ["Main chat"], reads: [String?] = [""]) { self.chats = chats; self.reads = reads }

    func currentChat() -> String? { log.append("chat"); return chats.count > 1 ? chats.removeFirst() : chats[0] }
    func focusViaAccessibility() -> Bool { log.append("focusAX"); return axFocus }
    func checkClickTarget() throws { log.append("checkTarget"); if let e = targetError { throw e } }
    func click() { log.append("click") }
    func readComposer() -> String? { log.append("read"); return reads.count > 1 ? reads.removeFirst() : reads[0] }
    func type(_ chunks: [[UInt16]]) { log.append("type"); typed = chunks }
    func clearComposer() { log.append("clear") }
    func pressReturn() { log.append("return") }
}

@Suite struct SendFlowTests {
    let text = "[Claude Code] hello there"

    @Test func happyPathOrder() throws {
        let d = FakeDriver(reads: ["", text])
        try SendFlow.perform(chat: "Main chat", text: text, driver: d)
        #expect(d.log == ["chat", "focusAX", "checkTarget", "click", "read", "type", "read", "chat", "return"])
        #expect(String(decoding: d.typed.flatMap { $0 }, as: UTF16.self) == text)
    }
    @Test func equalityUsesTheSameNormalisationAsVerification() throws {
        let d = FakeDriver(reads: ["", "[Claude Code]  hello   there"])
        try SendFlow.perform(chat: "Main chat", text: text, driver: d)
        #expect(d.log.last == "return")
    }
    @Test func theComposerCheckIsNotWhitespaceBlind() {
        // "hellothere" would pass a whitespace-removing comparison; the composer must hold the same words, spaced the same way.
        let d = FakeDriver(reads: ["", "[Claude Code] hellothere"])
        do { try SendFlow.perform(chat: "Main chat", text: text, driver: d); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "composer_mismatch") } catch { Issue.record("wrong error") }
        #expect(d.log.contains("clear") && !d.log.contains("return"))
    }
    @Test func wrapAndTrailingWhitespaceInTheComposerReadbackIsStillAccepted() throws {
        let d = FakeDriver(reads: ["", "  [Claude Code]\thello \n there \n"])
        try SendFlow.perform(chat: "Main chat", text: text, driver: d)
        #expect(d.log.last == "return")
    }
    @Test func dryRunTypesVerifiesClearsAndNeverPressesReturn() throws {
        let d = FakeDriver(reads: ["", text])
        try SendFlow.perform(chat: "Main chat", text: text, driver: d, dryRun: true)
        #expect(d.log == ["chat", "focusAX", "checkTarget", "click", "read", "type", "read", "chat", "clear"])
    }
    @Test func dryRunStillRefusesAMismatchWithoutReturn() {
        let d = FakeDriver(reads: ["", "[Claude Code] something else"])
        #expect(throws: MuseError.self) { try SendFlow.perform(chat: "Main chat", text: text, driver: d, dryRun: true) }
        #expect(!d.log.contains("return"))
    }
    @Test func wrongChatBeforeClickingTypesNothing() {
        let d = FakeDriver(chats: ["Other"])
        #expect(throws: MuseError.self) { try SendFlow.perform(chat: "Main chat", text: text, driver: d) }
        #expect(d.log == ["chat"])
    }
    @Test func chatChangesBeforeReturnClearsAndNeverPressesReturn() {
        let d = FakeDriver(chats: ["Main chat", "Work"], reads: ["", text])
        do { try SendFlow.perform(chat: "Main chat", text: text, driver: d); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "chat_changed") } catch { Issue.record("wrong error") }
        #expect(d.log.contains("clear") && !d.log.contains("return"))
    }
    @Test func extraTextFromTheUserIsAMismatch() {
        let d = FakeDriver(reads: ["", text + " plus what the user typed"])
        do { try SendFlow.perform(chat: "Main chat", text: text, driver: d); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "composer_mismatch") } catch { Issue.record("wrong error") }
        #expect(d.log.contains("clear") && !d.log.contains("return"))
    }
    @Test func textInsertedInTheMiddleIsAMismatch() {
        let d = FakeDriver(reads: ["", "[Claude Code] hello XX there"])
        #expect(throws: MuseError.self) { try SendFlow.perform(chat: "Main chat", text: text, driver: d) }
        #expect(!d.log.contains("return"))
    }
    @Test func substringIsNotEnough() {
        let d = FakeDriver(reads: ["", "[Claude Code] hello"])
        #expect(throws: MuseError.self) { try SendFlow.perform(chat: "Main chat", text: text, driver: d) }
        #expect(d.log.contains("clear") && !d.log.contains("return"))
    }
    @Test func unreadableComposerAfterTypingRefusesAndClears() {
        let d = FakeDriver(reads: [nil])
        do { try SendFlow.perform(chat: "Main chat", text: text, driver: d); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "composer_mismatch") } catch { Issue.record("wrong error") }
        #expect(d.log.contains("clear") && !d.log.contains("return"))
    }
    @Test func existingDraftIsNeverTypedOverNorCleared() {
        let d = FakeDriver(reads: ["half written note"])
        do { try SendFlow.perform(chat: "Main chat", text: text, driver: d); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "composer_mismatch") } catch { Issue.record("wrong error") }
        #expect(!d.log.contains("type") && !d.log.contains("clear") && !d.log.contains("return"))
    }
    @Test func hitTestRefusalHappensBeforeAnyClickOrKey() {
        let d = FakeDriver(); d.targetError = .clickTargetMismatch("x")
        do { try SendFlow.perform(chat: "Main chat", text: text, driver: d); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "click_target_mismatch") } catch { Issue.record("wrong error") }
        #expect(d.log == ["chat", "focusAX", "checkTarget"])
    }
    @Test func accessibilityFocusSkipsTheClick() throws {
        let d = FakeDriver(reads: ["", text]); d.axFocus = true
        try SendFlow.perform(chat: "Main chat", text: text, driver: d)
        #expect(!d.log.contains("click") && !d.log.contains("checkTarget") && d.log.last == "return")
    }
    @Test func newErrorCodesAreStable() {
        #expect(MuseError.composerMismatch("x").code == "composer_mismatch")
        #expect(MuseError.clickTargetMismatch("x").code == "click_target_mismatch")
        #expect(MuseError.chatChanged("x").code == "chat_changed")
        #expect(MuseError.composerMismatch("why").message.contains("why"))
    }
}
