import Testing
import Foundation
import CryptoKit
@testable import MuseAXCore

@Suite struct RulesUpdaterTests {
    let k = Keys.fresh()
    let url = URL(string: "https://example.test/rules/muse.json")!

    /// Serves `json` at the URL and `sig` at URL + ".sig".
    func fetcher(json: Data?, sig: String?, calls: Calls = Calls()) -> Fetcher {
        { u in
            calls.urls.append(u.absoluteString)
            if u == self.url, let j = json { return .success(j) }
            if u.absoluteString == self.url.absoluteString + ".sig", let s = sig { return .success(Data(s.utf8)) }
            return .failure(FetchFailure("HTTP 404"))
        }
    }
    final class Calls { var urls: [String] = [] }

    func update(_ f: @escaping Fetcher, home: URL) -> RulesUpdateOutcome {
        RulesUpdater.update(url: url, home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document, fetch: f)
    }

    @Test func validNewerRulesAreCached() {
        let home = Fx.tempDir(); let json = Fx.json(Fx.doc(revision: 7))
        let calls = Calls()
        let o = update(fetcher(json: json, sig: Keys.sign(json, k.priv), calls: calls), home: home)
        #expect(o.updated && o.reason == "updated" && o.revision == 7)
        // The bot index is looked for first (absent here), then the rules and their signature.
        #expect(calls.urls.filter { !$0.hasSuffix("index.json") && !$0.hasSuffix("index.json.sig") }.count == 2)
        let l = RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document)
        #expect(l.source == "cache" && l.revision == 7)
    }
    @Test func badSignatureIsRejectedAndNothingIsWritten() {
        let home = Fx.tempDir(); let json = Fx.json(Fx.doc(revision: 7))
        let o = update(fetcher(json: json, sig: Keys.sign(json, Keys.fresh().priv)), home: home)
        #expect(!o.updated && o.reason == "bad_signature")
        #expect(!FileManager.default.fileExists(atPath: RulesStore.cachePaths(home: home, bot: "muse").json.path))
    }
    @Test func truncatedFileIsRejected() {
        let home = Fx.tempDir(); let json = Fx.json(Fx.doc(revision: 7))
        let o = update(fetcher(json: json.prefix(json.count / 2), sig: Keys.sign(json, k.priv)), home: home)
        // A cut-off file has no readable key_id any more, so it is refused before its signature is even compared.
        #expect(!o.updated && o.reason == "untrusted_key" && o.detail == "key_id_required")
        // Cut off after the key_id is still caught by the signature (the file is JSON-valid only when complete, so use a tampered copy).
        let tampered = Data(String(decoding: json, as: UTF8.self).replacingOccurrences(of: "\"revision\":7", with: "\"revision\":8").utf8)
        let t = update(fetcher(json: tampered, sig: Keys.sign(json, k.priv)), home: Fx.tempDir())
        #expect(!t.updated && t.reason == "bad_signature")
    }
    @Test func newerSchemaIsRejectedGracefully() {
        let home = Fx.tempDir(); let json = Data(#"{"schema":2,"bot":"muse","revision":9,"key_id":"rules-1","profiles":{"new":"shape"}}"#.utf8)
        let o = update(fetcher(json: json, sig: Keys.sign(json, k.priv)), home: home)
        #expect(!o.updated && o.reason == "schema_unsupported" && o.detail?.contains("2") == true)
    }
    @Test func signedButInvalidRulesAreRejected() {
        let home = Fx.tempDir(); let json = Data(#"{"schema":1,"bot":"other","revision":1,"key_id":"rules-1","profiles":[]}"#.utf8)
        #expect(update(fetcher(json: json, sig: Keys.sign(json, k.priv)), home: home).reason == "invalid_rules")
    }
    @Test func networkErrorKeepsCurrentRules() throws {
        let home = Fx.tempDir()
        let json = Fx.json(Fx.doc(revision: 4))
        try RulesStore.writeCache(json: json, signature: Keys.sign(json, k.priv), home: home, bot: "muse")
        let o = update({ _ in .failure(FetchFailure("offline")) }, home: home)
        #expect(!o.updated && o.reason == "network_error" && o.detail == "offline")
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).revision == 4)
    }
    @Test func missingSignatureFileIsNetworkError() {
        let json = Fx.json(Fx.doc(revision: 7))
        #expect(update(fetcher(json: json, sig: nil), home: Fx.tempDir()).reason == "network_error")
    }
    @Test func notNewerThanCurrentIsSkipped() throws {
        let home = Fx.tempDir()
        let cur = Fx.json(Fx.doc(revision: 6))
        try RulesStore.writeCache(json: cur, signature: Keys.sign(cur, k.priv), home: home, bot: "muse")
        let old = Fx.json(Fx.doc(revision: 5))
        let o = update(fetcher(json: old, sig: Keys.sign(old, k.priv)), home: home)
        #expect(!o.updated && o.reason == "not_newer")
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).revision == 6)
    }
    @Test func identicalRulesAreUnchanged() throws {
        let home = Fx.tempDir(); let json = Fx.json(Fx.doc(revision: 6))
        let sig = Keys.sign(json, k.priv)
        #expect(update(fetcher(json: json, sig: sig), home: home).updated)
        #expect(update(fetcher(json: json, sig: sig), home: home).reason == "unchanged")
    }
    @Test func oversizedResponseIsRejected() {
        let big = Data(repeating: 0x20, count: RulesUpdater.maxBytes + 1)
        #expect(update(fetcher(json: big, sig: "x"), home: Fx.tempDir()).reason == "invalid_rules")
    }
    @Test func urlPolicy() {
        #expect(RulesUpdater.isAllowed(URL(string: "https://raw.githubusercontent.com/a/b/main/rules/muse.json")!))
        #expect(RulesUpdater.isAllowed(URL(string: "http://127.0.0.1:8080/muse.json")!))
        #expect(RulesUpdater.isAllowed(URL(string: "http://localhost:8080/muse.json")!))
        #expect(RulesUpdater.isAllowed(URL(fileURLWithPath: "/tmp/muse.json")))
        #expect(!RulesUpdater.isAllowed(URL(string: "http://example.com/muse.json")!))
        #expect(!RulesUpdater.isAllowed(URL(string: "ftp://example.com/muse.json")!))
    }
    @Test func urlFromEnv() {
        #expect(RulesUpdater.url(env: [:], bot: "muse").absoluteString == RulesUpdater.defaultURL(bot: "muse"))
        #expect(RulesUpdater.url(env: ["CBB_RULES_URL": "http://127.0.0.1:9/x.json"], bot: "muse").absoluteString == "http://127.0.0.1:9/x.json")
        #expect(RulesUpdater.url(env: ["CBB_RULES_URL": ""], bot: "muse").absoluteString == RulesUpdater.defaultURL(bot: "muse"))
    }
    @Test func disallowedUrlNeverFetches() {
        var called = false
        let o = RulesUpdater.update(url: URL(string: "http://example.com/x.json")!, home: Fx.tempDir(), bot: "muse", trust: .rules(k), builtin: BuiltinRules.document) { _ in called = true; return .failure(FetchFailure("x")) }
        #expect(o.reason == "bad_url" && !called)
    }
    @Test func liveFetcherReadsFileUrlsAndReportsMissing() throws {
        let dir = Fx.tempDir(); let f = dir.appendingPathComponent("a.json")
        try Data("hello".utf8).write(to: f)
        if case .success(let d) = LiveFetcher.fetch(f) { #expect(d == Data("hello".utf8)) } else { Issue.record("expected success") }
        if case .success = LiveFetcher.fetch(dir.appendingPathComponent("missing")) { Issue.record("expected failure") }
    }
    @Test func liveFetcherStopsAtTheSizeCapInsteadOfReadingEverything() throws {
        let dir = Fx.tempDir(); let f = dir.appendingPathComponent("big.json")
        try Data(repeating: 0x20, count: 1000).write(to: f)
        if case .failure(let e) = LiveFetcher.fetch(f, maxBytes: 999) { #expect(e.tooLarge && e.message.contains("999")) } else { Issue.record("expected failure") }
        if case .success(let d) = LiveFetcher.fetch(f, maxBytes: 1000) { #expect(d.count == 1000) } else { Issue.record("expected success at exactly the cap") }
        #expect(LiveFetcher.defaultMaxBytes == RulesUpdater.maxBytes)
    }
    @Test func aBodyCutOffAtTheCapIsReportedAsAnInvalidFileNotANetworkError() {
        let home = Fx.tempDir()
        let o = update({ _ in .failure(FetchFailure("larger than \(RulesUpdater.maxBytes) bytes", tooLarge: true)) }, home: home)
        #expect(!o.updated && o.reason == "invalid_rules" && o.detail?.contains("larger than") == true)
        #expect(!FileManager.default.fileExists(atPath: RulesStore.cachePaths(home: home, bot: "muse").json.path))
    }
    @Test func outcomeFields() {
        let f = RulesUpdateOutcome(updated: false, reason: "bad_signature", revision: nil, detail: "d").fields
        #expect(f["updated"] as? Bool == false && f["reason"] as? String == "bad_signature" && f["detail"] as? String == "d")
    }
}
