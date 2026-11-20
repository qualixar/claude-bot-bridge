import Testing
import Foundation
@testable import MuseAXCore

@Suite struct KeysetUpdaterTests {
    let h = Hierarchy()
    let url = URL(string: "https://example.test/keys/keyset.json")!

    func fetcher(_ s: (json: Data, sig: String)?, sigOverride: String? = nil) -> Fetcher {
        { u in
            guard let s = s else { return .failure(FetchFailure("HTTP 404")) }
            if u == self.url { return .success(s.json) }
            if u.absoluteString == self.url.absoluteString + ".sig" { return .success(Data((sigOverride ?? s.sig).utf8)) }
            return .failure(FetchFailure("HTTP 404"))
        }
    }
    func update(_ f: @escaping Fetcher, home: URL, bundled: (json: Data, signature: String)? = nil) -> KeysetUpdateOutcome {
        KeysetUpdater.update(url: url, home: home, rootKey: h.root.pub, bundled: bundled, fetch: f, now: h.now)
    }
    func issued(_ daysAgo: Double, revoked: [String] = []) -> (json: Data, sig: String) {
        h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-daysAgo * 86400), revoked: revoked))
    }

    @Test func aRootSignedKeysetIsCached() {
        let home = Fx.tempDir()
        let o = update(fetcher(issued(1)), home: home)
        #expect(o.updated && o.reason == "updated")
        guard case .valid(_, let src) = KeysetStore.load(home: home, rootKey: h.root.pub, bundled: nil, now: h.now) else { Issue.record("expected valid"); return }
        #expect(src == "cache")
    }
    @Test func aKeysetSignedByAnotherKeyIsRejectedAndNothingIsWritten() {
        let home = Fx.tempDir(), s = issued(1)
        let o = update(fetcher(s, sigOverride: Keys.sign(s.json, h.rules.priv)), home: home)
        #expect(!o.updated && o.reason == "bad_signature")
        #expect(!FileManager.default.fileExists(atPath: KeysetStore.cachePaths(home: home).json.path))
    }
    @Test func aRevocationReplacesTheCachedKeysetAsSoonAsItIsNewer() {
        let home = Fx.tempDir()
        #expect(update(fetcher(issued(5)), home: home).updated)
        let o = update(fetcher(issued(1, revoked: ["rules-1"])), home: home)
        #expect(o.updated)
        guard case .valid(let k, _) = KeysetStore.load(home: home, rootKey: h.root.pub, bundled: nil, now: h.now) else { Issue.record("expected valid"); return }
        #expect(k.revoked == ["rules-1"])
    }
    @Test func anOlderKeysetCannotRollBackARevocation() {
        let home = Fx.tempDir()
        #expect(update(fetcher(issued(1, revoked: ["rules-1"])), home: home).updated)
        let o = update(fetcher(issued(9)), home: home)   // validly signed, but older: replays the world before the revocation
        #expect(!o.updated && o.reason == "not_newer")
    }
    @Test func theBundledKeysetCountsAsCurrentToo() {
        let bundled = issued(1, revoked: ["rules-1"])
        let o = update(fetcher(issued(9)), home: Fx.tempDir(), bundled: (bundled.json, bundled.sig))
        #expect(!o.updated && o.reason == "not_newer")
    }
    @Test func anExpiredKnownKeysetIsStillTheFloor() {
        // Bundled keyset: issued 2 days ago and already expired. An older valid one from the network must not be installed.
        let expired = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 2), notAfter: h.iso(h.now.addingTimeInterval(-60))))
        let o = update(fetcher(issued(9)), home: Fx.tempDir(), bundled: (expired.json, expired.sig))
        #expect(!o.updated && o.reason == "not_newer")
        // A newer valid one is installed.
        let n = update(fetcher(issued(1).self), home: Fx.tempDir(), bundled: nil)
        #expect(n.updated)
    }
    @Test func theSameKeysetTwiceIsUnchanged() {
        let home = Fx.tempDir(), s = issued(1)
        #expect(update(fetcher(s), home: home).updated)
        #expect(update(fetcher(s), home: home).reason == "unchanged")
    }
    @Test func anExpiredKeysetIsNotInstalled() {
        let s = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 400), notAfter: h.iso(h.now.addingTimeInterval(-60))))
        let o = update(fetcher(s), home: Fx.tempDir())
        #expect(!o.updated && o.reason == "expired")
    }
    @Test func malformedButSignedIsInvalidKeyset() {
        let j = Data(#"{"schema":1,"keys":[]}"#.utf8)
        let o = update(fetcher((j, Keys.sign(j, h.root.priv))), home: Fx.tempDir())
        #expect(!o.updated && o.reason == "invalid_keyset")
    }
    @Test func networkErrorsAndBadUrlsChangeNothing() {
        #expect(update(fetcher(nil), home: Fx.tempDir()).reason == "network_error")
        var called = false
        let o = KeysetUpdater.update(url: URL(string: "http://example.com/k.json")!, home: Fx.tempDir(), rootKey: h.root.pub, bundled: nil, fetch: { _ in called = true; return .failure(FetchFailure("x")) }, now: h.now)
        #expect(o.reason == "bad_url" && !called)
    }
    @Test func oversizedResponsesAreRejected() {
        let big = Data(repeating: 0x20, count: KeysetUpdater.maxBytes + 1)
        #expect(update({ _ in .success(big) }, home: Fx.tempDir()).reason == "invalid_keyset")
    }
    @Test func aBodyCutOffAtTheCapIsAnInvalidKeysetNotANetworkError() {
        let o = update({ _ in .failure(FetchFailure("larger than 65536 bytes", tooLarge: true)) }, home: Fx.tempDir())
        #expect(!o.updated && o.reason == "invalid_keyset")
    }
    @Test func urlFromEnv() {
        #expect(KeysetUpdater.url(env: [:])?.absoluteString == KeysetUpdater.defaultURL)
        #expect(KeysetUpdater.url(env: ["CBB_KEYSET_URL": "http://127.0.0.1:9/k.json"])?.absoluteString == "http://127.0.0.1:9/k.json")
        #expect(KeysetUpdater.url(env: ["CBB_KEYSET_URL": ""])?.absoluteString == KeysetUpdater.defaultURL)
        // A custom rules URL (a test server, a mirror) must not make the helper call the real GitHub for the keyset.
        #expect(KeysetUpdater.url(env: ["CBB_RULES_URL": "http://127.0.0.1:9/muse.json"]) == nil)
        #expect(KeysetUpdater.url(env: ["CBB_RULES_URL": "http://127.0.0.1:9/muse.json", "CBB_KEYSET_URL": "http://127.0.0.1:9/k.json"])?.absoluteString == "http://127.0.0.1:9/k.json")
    }
}
