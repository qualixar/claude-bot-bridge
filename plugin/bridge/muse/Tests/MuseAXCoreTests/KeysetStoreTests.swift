import Testing
import Foundation
@testable import MuseAXCore

@Suite struct KeysetStoreTests {
    let h = Hierarchy()
    func load(_ home: URL, bundled: (json: Data, signature: String)? = nil) -> KeysetState {
        KeysetStore.load(home: home, rootKey: h.root.pub, bundled: bundled, now: h.now)
    }
    func newer(_ days: Double) -> (json: Data, sig: String) { h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 + days * 86400))) }

    @Test func nothingShippedMeansAbsent() { #expect(load(Fx.tempDir()) == .absent) }
    @Test func theBundledKeysetIsUsedWhenThereIsNoCache() {
        let b = h.signed()
        guard case .valid(_, let src) = load(Fx.tempDir(), bundled: (b.json, b.sig)) else { Issue.record("expected valid"); return }
        #expect(src == "bundled")
    }
    @Test func aNewerCachedKeysetBeatsTheBundledOne() throws {
        let home = Fx.tempDir(), n = newer(0.5)
        try KeysetStore.writeCache(json: n.json, signature: n.sig, home: home)
        let b = h.signed()
        guard case .valid(let k, let src) = load(home, bundled: (b.json, b.sig)) else { Issue.record("expected valid"); return }
        let issued = try Keyset.decode(n.json).issuedAt
        #expect(src == "cache" && k.issuedAt == issued)
    }
    @Test func anOlderCachedKeysetNeverReplacesANewerBundledOne() throws {
        let home = Fx.tempDir(), old = newer(-5)
        try KeysetStore.writeCache(json: old.json, signature: old.sig, home: home)
        let b = newer(0.5)
        guard case .valid(_, let src) = load(home, bundled: (b.json, b.sig)) else { Issue.record("expected valid"); return }
        #expect(src == "bundled")
    }
    @Test func aCacheWithABadSignatureIsIgnoredWhenTheBundledOneIsGood() throws {
        let home = Fx.tempDir(), j = h.bytes(h.keysetObject())
        try KeysetStore.writeCache(json: j, signature: Keys.sign(j, h.rules.priv), home: home)   // signed by the wrong key
        let b = h.signed()
        guard case .valid(_, let src) = load(home, bundled: (b.json, b.sig)) else { Issue.record("expected valid"); return }
        #expect(src == "bundled")
    }
    @Test func aBadCacheAloneIsInvalidNotAbsent() throws {
        let home = Fx.tempDir(), j = h.bytes(h.keysetObject())
        try KeysetStore.writeCache(json: j, signature: Keys.sign(j, h.rules.priv), home: home)
        guard case .invalid = load(home) else { Issue.record("expected invalid"); return }
    }
    @Test func anExpiredKeysetIsReportedWhenNothingValidExists() {
        let s = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 400), notAfter: h.iso(h.now.addingTimeInterval(-60))))
        guard case .expired = load(Fx.tempDir(), bundled: (s.json, s.sig)) else { Issue.record("expected expired"); return }
    }
    // The issued_at floor: the newest verified keyset decides, valid or not.
    @Test func anExpiredNewestKeysetFailsClosedInsteadOfLettingAnOlderValidOneWin() throws {
        let valid = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 30)))
        let expired = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 10), notAfter: h.iso(h.now.addingTimeInterval(-86400))))
        // newest = bundled, expired; older valid copy in the cache
        let home = Fx.tempDir()
        try KeysetStore.writeCache(json: valid.json, signature: valid.sig, home: home)
        guard case .expired(let k) = load(home, bundled: (expired.json, expired.sig)) else { Issue.record("expected expired"); return }
        #expect(k.issuedAt == (try Keyset.decode(expired.json)).issuedAt)
        // newest = cache, expired; older valid copy bundled
        let home2 = Fx.tempDir()
        try KeysetStore.writeCache(json: expired.json, signature: expired.sig, home: home2)
        guard case .expired = load(home2, bundled: (valid.json, valid.sig)) else { Issue.record("expected expired"); return }
    }
    @Test func aRevocationInTheCacheSurvivesAnOlderBundledKeysetWithoutAnyNetwork() throws {
        let home = Fx.tempDir()
        let revoking = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400), revoked: ["rules-1"]))
        try KeysetStore.writeCache(json: revoking.json, signature: revoking.sig, home: home)
        let older = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 9)))
        guard case .valid(let k, let src) = load(home, bundled: (older.json, older.sig)) else { Issue.record("expected valid"); return }
        #expect(src == "cache" && k.revoked == ["rules-1"])
        let ctx = TrustContext(rootKey: h.root.pub, keyset: .valid(k, source: src), now: h.now)
        let data = Data("x".utf8)
        #expect(Trust.verify(data: data, signatureBase64: Keys.sign(data, h.rules.priv), keyId: "rules-1", use: "rules", ctx: ctx) == .untrusted("key_revoked"))
    }
    @Test func theCacheUsesOneDirectoryBehindOneSymlink() throws {
        let home = Fx.tempDir(), s = h.signed()
        try KeysetStore.writeCache(json: s.json, signature: s.sig, home: home)
        let link = try FileManager.default.destinationOfSymbolicLink(atPath: home.appendingPathComponent("keys/current").path)
        #expect(link.hasPrefix("v-"))
        #expect(FileManager.default.fileExists(atPath: KeysetStore.cachePaths(home: home).json.path))
        #expect(FileManager.default.fileExists(atPath: KeysetStore.cachePaths(home: home).sig.path))
    }
}

@Suite struct BuiltinKeysetTests {
    @Test func theCompiledInKeysetMatchesTheRepoFilesOrBothAreUnsigned() throws {
        let json = Fx.repoFile("keys/keyset.json"), sig = Fx.repoFile("keys/keyset.json.sig")
        guard FileManager.default.fileExists(atPath: json.path) else { return }   // plugin installed without the repo root
        if FileManager.default.fileExists(atPath: sig.path) {
            let b = try #require(BuiltinKeyset.bundled, "run plugin/scripts/sync-builtin-rules.sh after signing the keyset")
            #expect(b.json == (try Data(contentsOf: json)))
            #expect(b.signature == (try String(contentsOf: sig, encoding: .utf8)).trimmingCharacters(in: .whitespacesAndNewlines))
            // The bundled keyset is what the shipped root key vouches for.
            guard case .valid(let k, _) = KeysetVerifier.verify(json: b.json, signatureBase64: b.signature, rootKey: ReleaseKey.publicKey, now: Date()) else {
                Issue.record("the compiled-in keyset does not verify against the root key, or it expired"); return
            }
            #expect(k.keys.contains { $0.use == "rules" } && k.keys.contains { $0.use == "binary" })
        } else {
            #expect(BuiltinKeyset.bundled == nil, "an unsigned keyset must not be compiled in")
            #expect(FileManager.default.fileExists(atPath: Fx.repoFile("keys/UNSIGNED").path), "no signature and no keys/UNSIGNED marker")
        }
    }
    @Test func theDraftKeysetListsTheTwoPublishedKeys() throws {
        let json = Fx.repoFile("keys/keyset.json")
        guard FileManager.default.fileExists(atPath: json.path) else { return }
        let k = try Keyset.decode(try Data(contentsOf: json))
        func pem(_ f: String) throws -> Data {
            let b64 = try String(contentsOf: Fx.repoFile("keys/\(f)"), encoding: .utf8).split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
            return Data(base64Encoded: b64)!.suffix(32)
        }
        #expect(k.keys.first { $0.use == "rules" }?.publicKey == (try pem("rules-public.pem")))
        #expect(k.keys.first { $0.use == "binary" }?.publicKey == (try pem("binary-public.pem")))
        #expect(!k.keys.contains { $0.publicKey == ReleaseKey.publicKey }, "the root key must never be a keyset entry")
        #expect(try pem("root-public.pem") == ReleaseKey.publicKey)
    }
}
