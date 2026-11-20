import Testing
import Foundation
@testable import MuseAXCore

/// Shared with mcp/test/validate-vectors.test.js: both validators must agree on every case.
struct SendVector: Sendable { let name: String; let valid: Bool; let text: String }

enum SendVectors {
    static func load() throws -> [SendVector] {
        let data = try Data(contentsOf: Fx.repoFile("plugin/bridge/muse/test-vectors/send-validation.json"))
        let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        return (root["cases"] as! [[String: Any]]).map { c in
            var text = c["text"] as? String ?? ""
            if let r = c["repeat"] as? [String: Any] {
                text = (c["head"] as! String) + String(repeating: r["s"] as! String, count: r["n"] as! Int) + (c["tail"] as? String ?? "")
            }
            return SendVector(name: c["name"] as! String, valid: c["valid"] as! Bool, text: text)
        }
    }
}

@Suite struct SendValidationVectorTests {
    @Test func sharedVectorsAgree() throws {
        let vectors = try SendVectors.load()
        #expect(vectors.count > 30)
        for v in vectors {
            let accepted = (try? SendRules.validate(v.text)) != nil
            #expect(accepted == v.valid, "\(v.name)")
        }
    }
    @Test func limitCountsUnicodeScalarsNotGraphemes() throws {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        #expect(family.count == 1 && family.unicodeScalars.count == 5)
        #expect(throws: MuseError.self) { try SendRules.validate("[Claude Code] " + String(repeating: family, count: 97) + "ab") }
    }
}

@Suite struct TextChunkerTests {
    @Test func chunksReassembleAndRespectTheLimit() {
        let text = "[Claude Code] " + String(repeating: "abcdefghij", count: 48)
        let chunks = TextChunker.chunks(text)
        #expect(chunks.allSatisfy { !$0.isEmpty && $0.count <= 20 })
        #expect(String(decoding: chunks.flatMap { $0 }, as: UTF16.self) == text)
        #expect(chunks.count == (text.utf16.count + 19) / 20)
    }
    @Test func neverSplitsAGrapheme() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"   // 8 UTF-16 units
        let text = "abcde" + family + family + family + "e\u{0301}x"
        let chunks = TextChunker.chunks(text)
        let strings = chunks.map { String(decoding: $0, as: UTF16.self) }
        #expect(strings.joined() == text)
        for s in strings { #expect(s.count == s.unicodeScalars.count || s.contains(family) || s.contains("e\u{0301}")) }
        for c in chunks { #expect(c.count <= 20) }
        // A grapheme must live wholly inside one chunk.
        for g in text {
            let n = strings.filter { $0.contains(g) }.count
            #expect(n >= 1, "\(g)")
        }
        #expect(!strings.contains { $0.hasPrefix("\u{200D}") || $0.hasPrefix("\u{0301}") })
    }
    @Test func oversizedGraphemeIsSplitOnScalarsNeverInsideASurrogatePair() {
        let monster = "a" + String(repeating: "\u{0301}", count: 30) + "\u{1F600}\u{FE0F}"
        let chunks = TextChunker.chunks(monster)
        #expect(chunks.allSatisfy { $0.count <= 20 && !$0.isEmpty })
        #expect(String(decoding: chunks.flatMap { $0 }, as: UTF16.self) == monster)
        for c in chunks { #expect(String(decoding: c, as: UTF16.self).unicodeScalars.allSatisfy { $0 != "\u{FFFD}" }) }
    }
    @Test func emptyTextHasNoChunksAndFiveHundredCharsIsAboutTwentyFiveEvents() {
        #expect(TextChunker.chunks("").isEmpty)
        #expect(TextChunker.chunks(String(repeating: "a", count: 500)).count == 25)
    }
}

@Suite struct SameTextTests {
    @Test func equalityIsExactAfterNormalisation() {
        #expect(MessageParser.sameText("[Claude Code] say \"hi\"", "[Claude Code]  say \u{201C}hi\u{201D}"))
        #expect(!MessageParser.sameText("[Claude Code] hi", "[Claude Code] hi there"))
        #expect(!MessageParser.sameText("[Claude Code] hi", "x[Claude Code] hi"))
    }
    @Test func lastUserMustEqualNotContain() {
        let sent = "[Claude Code] ping"
        let user = { (t: String) in [Message(role: "user", text: t)] }
        #expect(MessageParser.lastUserEquals(sent, in: user(sent)))
        #expect(!MessageParser.lastUserEquals(sent, in: user("[Claude Code] ping and something the user typed")))
        #expect(!MessageParser.lastUserEquals(sent, in: [Message(role: "assistant", text: sent)]))
    }
}

@Suite struct ClickTargetTests {
    let composer = CGRect(x: 300, y: 600, width: 768, height: 58)
    @Test func acceptsAnElementInsideMuseWithinTheComposer() throws {
        try ClickTarget.validate(hit: ClickHit(pid: 42, frame: CGRect(x: 302, y: 610, width: 700, height: 40)), musePid: 42, composer: composer)
        try ClickTarget.validate(hit: ClickHit(pid: 42, frame: composer), musePid: 42, composer: composer)
    }
    @Test func refusesAnotherProcess() {
        #expect(throws: MuseError.self) { try ClickTarget.validate(hit: ClickHit(pid: 7, frame: composer), musePid: 42, composer: composer) }
    }
    @Test func refusesNothingUnderThePoint() {
        #expect(throws: MuseError.self) { try ClickTarget.validate(hit: nil, musePid: 42, composer: composer) }
    }
    @Test func refusesAnElementOutsideTheComposer() {
        let sidebar = CGRect(x: 0, y: 26, width: 200, height: 650)
        // The whole window is accepted on purpose: see acceptsTheMuseWindowWhenTheNativeComposerIsNotInTheTree.
        for f in [sidebar, CGRect(x: 302, y: 700, width: 100, height: 20), .zero] {
            #expect(throws: MuseError.self) { try ClickTarget.validate(hit: ClickHit(pid: 42, frame: f), musePid: 42, composer: composer) }
        }
    }
    @Test func acceptsTheMuseWindowWhenTheNativeComposerIsNotInTheTree() throws {
        // Muse 13.1: the hit test returns the window (533,26 614x658) because the native composer is not exposed.
        let c = CGRect(x: 545, y: 560, width: 590, height: 58)
        let window = CGRect(x: 533, y: 26, width: 614, height: 658)
        try ClickTarget.validate(hit: ClickHit(pid: 42, frame: window), musePid: 42, composer: c, point: CGPoint(x: 781, y: 589))
    }
    @Test func refusesAMusePopoverCoveringTheComposer() {
        let c = CGRect(x: 545, y: 560, width: 590, height: 58)
        let popover = CGRect(x: 700, y: 400, width: 200, height: 210)
        #expect(throws: MuseError.self) { try ClickTarget.validate(hit: ClickHit(pid: 42, frame: popover), musePid: 42, composer: c, point: CGPoint(x: 781, y: 589)) }
    }
    @Test func refusesAPointOutsideTheComposer() {
        let window = CGRect(x: 0, y: 0, width: 2000, height: 2000)
        #expect(throws: MuseError.self) { try ClickTarget.validate(hit: ClickHit(pid: 42, frame: window), musePid: 42, composer: composer, point: CGPoint(x: 10, y: 10)) }
    }
    @Test func refusalCodeIsClickTargetMismatch() {
        do { try ClickTarget.validate(hit: nil, musePid: 1, composer: composer); Issue.record("should throw") }
        catch let e as MuseError { #expect(e.code == "click_target_mismatch") } catch { Issue.record("wrong error") }
    }
}

@Suite struct ChatMatchTests {
    @Test func composerMustNameExactlyTheRequestedChat() {
        let c = Fx.p12.composer
        let t = "Message in Check assistant availability Attach files Send"
        #expect(ChatNames.composerMatches(title: t, chat: "Check assistant availability", rules: c))
        #expect(!ChatNames.composerMatches(title: t, chat: "Check assistant availability and more", rules: c))
        #expect(!ChatNames.composerMatches(title: t, chat: "Check", rules: c))
    }
}
