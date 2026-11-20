import Testing
import Foundation
@testable import MuseAXCore

@Suite struct UILockTests {
    func lockURL(_ home: URL) -> URL { UILock.path(home: home) }

    @Test func pathIsUnderTheBridgeHome() {
        let home = Fx.tempDir()
        #expect(UILock.path(home: home).lastPathComponent == ".ui.lock")
        #expect(UILock.path(home: home).deletingLastPathComponent().standardizedFileURL == home.standardizedFileURL)
    }
    @Test func runsTheBodyAndReleases() throws {
        let home = Fx.tempDir()
        let r = try UILock.withLock(home: home) { 42 }
        #expect(r == 42)
        #expect(!FileManager.default.fileExists(atPath: lockURL(home).path))
    }
    @Test func releasesWhenTheBodyThrows() {
        let home = Fx.tempDir()
        struct Boom: Error {}
        #expect(throws: Boom.self) { try UILock.withLock(home: home) { throw Boom() } }
        #expect(!FileManager.default.fileExists(atPath: lockURL(home).path))
    }
    @Test func aHeldLockMakesTheSecondCallerFailBusyWithoutRunningItsBody() throws {
        let home = Fx.tempDir()
        var ran = false
        try UILock.withLock(home: home) {
            do {
                try UILock.withLock(home: home, timeout: 0.3, pollInterval: 0.05) { ran = true }
                Issue.record("should be busy")
            } catch let e as MuseError { #expect(e.code == "busy") } catch { Issue.record("wrong error") }
        }
        #expect(!ran)
    }
    @Test func waitsForTheHolderToLeave() throws {
        let home = Fx.tempDir()
        let lock = FileLock.acquire(at: lockURL(home))!
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { lock.release() }
        var ran = false
        try UILock.withLock(home: home, timeout: 3, pollInterval: 0.05) { ran = true }
        #expect(ran)
    }
    @Test func aDeadOwnersOldLockIsTakenOver() throws {
        let home = Fx.tempDir()
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try "999999\nnonce\n".write(to: lockURL(home), atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -3600)], ofItemAtPath: lockURL(home).path)
        let r = try UILock.withLock(home: home, timeout: 1, pollInterval: 0.05) { "ok" }
        #expect(r == "ok")
    }
    @Test func busyIsRetryableAndSaysNothingWasTyped() {
        let e = MuseError.busy
        #expect(e.code == "busy" && e.message.contains("nothing was typed"))
        #expect(JSONOut.failure(e).contains("retry_after_seconds"))
    }
}

@Suite struct IdleGuardTests {
    @Test func thresholdDefaultsToThreeSecondsAndCanBeTunedOrDisabled() {
        #expect(IdleGuard.threshold(env: [:]) == 3)
        #expect(IdleGuard.threshold(env: ["CBB_IDLE_SECONDS": "7.5"]) == 7.5)
        #expect(IdleGuard.threshold(env: ["CBB_IDLE_SECONDS": "0"]) == 0)
        for bad in ["", "abc", "-1", "nan", "1e9"] { #expect(IdleGuard.threshold(env: ["CBB_IDLE_SECONDS": bad]) == 3, "\(bad)") }
    }
    @Test func recentInputRefusesWithAWaitHint() {
        do { try IdleGuard.check(secondsSinceInput: 1, threshold: 3); Issue.record("should throw") }
        catch let e as MuseError {
            #expect(e.code == "user_active")
            #expect(e.message.contains("nothing was typed"))
            #expect(JSONOut.failure(e).contains("\"retry_after_seconds\":2"))
        } catch { Issue.record("wrong error") }
    }
    @Test func quietUserOrDisabledGuardPasses() throws {
        try IdleGuard.check(secondsSinceInput: 3, threshold: 3)
        try IdleGuard.check(secondsSinceInput: 100, threshold: 3)
        try IdleGuard.check(secondsSinceInput: 0, threshold: 0)
    }
    @Test func retryHintIsAtLeastOneWholeSecond() {
        do { try IdleGuard.check(secondsSinceInput: 2.95, threshold: 3) } catch let e as MuseError {
            #expect(JSONOut.failure(e).contains("\"retry_after_seconds\":1"))
        } catch {}
    }
}

@Suite struct SendJournalTests {
    @Test func appendsOneLineWithHashAndLengthButNeverTheText() throws {
        let home = Fx.tempDir()
        let text = "[Claude Code] top secret plan"
        try SendJournal.append(.init(chat: "Main chat", text: text, outcome: "sent"), home: home, now: Date(timeIntervalSince1970: 0))
        let raw = try String(contentsOf: SendJournal.path(home: home), encoding: .utf8)
        #expect(!raw.contains("secret"))
        let o = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
        #expect(o["chat"] as? String == "Main chat" && o["outcome"] as? String == "sent")
        #expect(o["length"] as? Int == text.unicodeScalars.count)
        #expect(o["at"] as? String == "1970-01-01T00:00:00Z")
        #expect((o["sha256"] as? String)?.count == 64)
        #expect(o["text"] == nil)
        #expect(SendJournal.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
    @Test func appendsAreAppendOnlyAndReadBackNewestLast() throws {
        let home = Fx.tempDir()
        for (i, c) in ["sent", "chat_changed", "busy"].enumerated() {
            try SendJournal.append(.init(chat: "c\(i)", text: "[Claude Code] \(i)", outcome: c), home: home)
        }
        let all = SendJournal.read(home: home, last: nil)
        #expect(all.map { $0["outcome"] as? String } == ["sent", "chat_changed", "busy"])
        #expect(SendJournal.read(home: home, last: 2).map { $0["chat"] as? String } == ["c1", "c2"])
    }
    @Test func readingAMissingOrDamagedJournalIsSafe() throws {
        let home = Fx.tempDir()
        #expect(SendJournal.read(home: home, last: nil).isEmpty)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try "not json\n{\"chat\":\"ok\"}\n".write(to: SendJournal.path(home: home), atomically: true, encoding: .utf8)
        #expect(SendJournal.read(home: home, last: nil).count == 1)
    }
    @Test func fileIsPrivate() throws {
        let home = Fx.tempDir()
        try SendJournal.append(.init(chat: "c", text: "[Claude Code] x", outcome: "sent"), home: home)
        let perm = (try FileManager.default.attributesOfItem(atPath: SendJournal.path(home: home).path)[.posixPermissions] as? NSNumber)?.intValue
        #expect(perm == 0o600)
    }
}

final class FakeReader: ChatReader {
    var chats: [String?]; var snapshots: [[Message]]
    var polls = 0
    init(chats: [String?], snapshots: [[Message]]) { self.chats = chats; self.snapshots = snapshots }
    func currentChat() -> String? { chats.count > 1 ? chats.removeFirst() : chats[0] }
    func messages() -> [Message] { polls += 1; return snapshots.count > 1 ? snapshots.removeFirst() : snapshots[0] }
}

@Suite struct SendVerifierTests {
    let text = "[Claude Code] ping"
    let before = [Message(role: "user", text: "[Claude Code] older")]
    var arrived: [Message] { before + [Message(role: "user", text: text)] }

    @Test func arrivalInTheRequestedChatIsSent() {
        let r = FakeReader(chats: ["Main chat"], snapshots: [arrived])
        let v = SendVerifier.verify(r, chat: "Main chat", text: text, before: before, polls: 3, sleep: { _ in })
        #expect(v.sent && v.note == nil)
    }
    @Test func chatChangedBeforeVerificationIsNotSentEvenIfTheTextAppearsElsewhere() {
        let r = FakeReader(chats: ["Other chat"], snapshots: [arrived])
        let v = SendVerifier.verify(r, chat: "Main chat", text: text, before: before, polls: 3, sleep: { _ in })
        #expect(!v.sent)
        #expect(v.note == "chat_changed")
        #expect(v.openChat == "Other chat")
    }
    @Test func chatChangingBetweenPollsIsCaught() {
        let r = FakeReader(chats: ["Main chat", "Work"], snapshots: [before, arrived])
        let v = SendVerifier.verify(r, chat: "Main chat", text: text, before: before, polls: 3, sleep: { _ in })
        #expect(!v.sent && v.note == "chat_changed")
    }
    @Test func neverArrivingIsUnverifiedNotChatChanged() {
        let r = FakeReader(chats: ["Main chat"], snapshots: [before])
        let v = SendVerifier.verify(r, chat: "Main chat", text: text, before: before, polls: 3, sleep: { _ in })
        #expect(!v.sent && v.note == nil)
        #expect(r.polls == 3)
    }
    @Test func arrivalMatchingToleratesLineWrapping() {
        let wrapped = before + [Message(role: "user", text: "[Claude Code]\nping")]
        let r = FakeReader(chats: ["Main chat"], snapshots: [wrapped])
        #expect(SendVerifier.verify(r, chat: "Main chat", text: text, before: before, polls: 2, sleep: { _ in }).sent)
    }
}

@Suite struct ReplyWaiterTests {
    let user = Message(role: "user", text: "[Claude Code] q")
    func reply(_ t: String) -> [Message] { [user, Message(role: "assistant", text: t)] }

    @Test func returnsTheNewReplyOnceItIsStable() throws {
        var snaps = [[user], reply("par"), reply("partial"), reply("partial"), reply("partial")]
        let r = try ReplyWaiter.wait(timeout: 60, interval: 0, now: { Date() }, sleep: { _ in }, snapshot: { snaps.removeFirst() })
        #expect(r.text == "partial")
    }
    @Test func timesOut() {
        var clock = Date(timeIntervalSince1970: 0)
        #expect(throws: MuseError.self) {
            try ReplyWaiter.wait(timeout: 3, interval: 1, now: { clock }, sleep: { clock = clock.addingTimeInterval($0) }, snapshot: { [self.user] })
        }
    }
    @Test func aBusyPollIsSkippedNotFatalButTheFirstOneIs() throws {
        var n = 0
        var clock = Date(timeIntervalSince1970: 0)
        let r = try ReplyWaiter.wait(timeout: 100, interval: 1, now: { clock }, sleep: { clock = clock.addingTimeInterval($0) }, snapshot: {
            n += 1
            if n == 1 { return [self.user] }
            if n == 2 { throw MuseError.busy }
            return self.reply("done")
        })
        #expect(r.text == "done")
        var first = 0
        #expect(throws: MuseError.busy) {
            try ReplyWaiter.wait(timeout: 10, interval: 0, now: { Date() }, sleep: { _ in }, snapshot: { first += 1; throw MuseError.busy })
        }
        #expect(first == 1)
    }
    @Test func otherErrorsStopTheWait() {
        var n = 0
        #expect(throws: MuseError.chatNotFound("x")) {
            try ReplyWaiter.wait(timeout: 10, interval: 0, now: { Date() }, sleep: { _ in }, snapshot: { n += 1; if n > 1 { throw MuseError.chatNotFound("x") }; return [self.user] })
        }
    }
}

@Suite struct SelftestReportTests {
    let all: [(String, Bool)] = [("window", true), ("chat_list", false), ("composer", true)]
    @Test func aHiddenChatListIsInformationalNotAFailure() {
        let r = SelftestReport(all)
        #expect(r.failed.isEmpty)
        #expect(r.chatListVisible == false)
        #expect(r.checks["chat_list"] == nil && r.checks["composer"] == true)
    }
    @Test func realMissingAnchorsStillFail() {
        let r = SelftestReport([("window", true), ("chat_list", true), ("composer", false)])
        #expect(r.failed == ["composer"] && r.chatListVisible == true)
    }
    @Test func noChatListEntryMeansNothingToReport() { #expect(SelftestReport([("window", true)]).chatListVisible == nil) }
}

@Suite struct LogRotationTests {
    @Test func smallLogsAreLeftAlone() throws {
        let f = Fx.tempDir().appendingPathComponent("canary.log")
        try Data(repeating: 65, count: 100).write(to: f)
        LogRotation.trim(f, maxBytes: 1000, keepBytes: 500)
        #expect(try Data(contentsOf: f).count == 100)
    }
    @Test func oversizedLogsKeepTheNewestLinesWholeFromALineStart() throws {
        let f = Fx.tempDir().appendingPathComponent("canary.log")
        let lines = (0..<100).map { String(format: "line-%03d-xxxxxxxxxx\n", $0) }
        try Data(lines.joined().utf8).write(to: f)
        LogRotation.trim(f, maxBytes: 1000, keepBytes: 500)
        let kept = try String(contentsOf: f, encoding: .utf8)
        #expect(kept.utf8.count <= 500 && kept.utf8.count > 300)
        #expect(kept.hasPrefix("line-") && kept.hasSuffix("line-099-xxxxxxxxxx\n"))
    }
    @Test func missingFileIsFine() { LogRotation.trim(Fx.tempDir().appendingPathComponent("nope.log"), maxBytes: 10, keepBytes: 5) }
}
