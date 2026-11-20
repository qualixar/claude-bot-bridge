import Testing
import Foundation
@testable import MuseAXCore

/// Rules under the key hierarchy: key_id, expiry (`not_after`), the update channel and the signed bot index.
@Suite struct RulesKeyHierarchyTests {
    let h = Hierarchy()
    func rulesJSON(rev: Int, keyId: String? = "rules-1", notAfter: String? = nil, bot: String = "muse") -> Data {
        Fx.json(RulesDocument(schema: 1, bot: bot, revision: rev, profiles: BuiltinRules.document.profiles, keyId: keyId, notAfter: notAfter))
    }
    func store(_ json: Data, signedBy k: Keys.Pair, home: URL) throws { try RulesStore.writeCache(json: json, signature: Keys.sign(json, k.priv), home: home, bot: "muse") }
    func load(_ home: URL, _ ctx: TrustContext? = nil) -> LoadedRules {
        RulesStore.load(home: home, bot: "muse", trust: ctx ?? h.ctx, builtin: BuiltinRules.document)
    }

    @Test func cachedRulesSignedByTheRulesKeyAreUsedAndReportTheirKeyId() throws {
        let home = Fx.tempDir(); try store(rulesJSON(rev: 5), signedBy: h.rules, home: home)
        let l = load(home)
        #expect(l.source == "cache" && l.revision == 5 && l.keyId == "rules-1" && l.note == nil)
    }
    @Test func cachedRulesSignedByTheBinaryKeyOrTheRootAreIgnoredOnceAKeysetIsKnown() throws {
        for signer in [h.binary, h.root] {
            let home = Fx.tempDir(); try store(rulesJSON(rev: 5), signedBy: signer, home: home)
            let l = load(home)
            #expect(l.source == "builtin" && l.note == "cache_bad_signature")
        }
        let home = Fx.tempDir(); try store(rulesJSON(rev: 5, keyId: "binary-1"), signedBy: h.binary, home: home)
        #expect(load(home).note == "cache_key_wrong_use")
    }
    @Test func aRevocationInTheKeysetRetiresRulesAlreadyOnDisk() throws {
        let home = Fx.tempDir(); try store(rulesJSON(rev: 5), signedBy: h.rules, home: home)
        let revoked = TrustContext(rootKey: h.root.pub, keyset: .valid(try Keyset.decode(h.bytes(h.keysetObject(revoked: ["rules-1"]))), source: "t"), now: h.now)
        let l = load(home, revoked)
        #expect(l.source == "builtin" && l.note == "cache_key_revoked")
    }
    @Test func rootSignedRulesWithoutKeyIdAreNeverUsed() throws {
        // There is no compatibility path: the root signs keysets only, and every rules document names its key.
        let home = Fx.tempDir(); try store(rulesJSON(rev: 5, keyId: nil), signedBy: h.root, home: home)
        #expect(load(home).note == "cache_key_id_required")
        for state in [KeysetState.absent, .invalid("bad_signature")] {
            let l = load(home, TrustContext(rootKey: h.root.pub, keyset: state, now: h.now))
            #expect(l.source == "builtin" && l.note == "cache_key_id_required")
        }
    }
    @Test func anExpiredKeysetRetiresTheCachedRulesWithAClearNote() throws {
        let home = Fx.tempDir(); try store(rulesJSON(rev: 5), signedBy: h.rules, home: home)
        let l = load(home, TrustContext(rootKey: h.root.pub, keyset: .expired(h.keyset), now: h.now))
        #expect(l.source == "builtin" && l.note == "cache_keyset_expired")
    }
    @Test func rulesPastTheirNotAfterAreIgnoredAndTheBuiltInOnesAreUsed() throws {
        let home = Fx.tempDir()
        try store(rulesJSON(rev: 5, notAfter: h.iso(h.now.addingTimeInterval(-60))), signedBy: h.rules, home: home)
        let l = load(home)
        #expect(l.source == "builtin" && l.note == "cache_expired" && l.revision == BuiltinRules.document.revision)
    }
    @Test func rulesBeforeTheirNotAfterAreUsed() throws {
        let home = Fx.tempDir(); try store(rulesJSON(rev: 5, notAfter: h.iso(h.now.addingTimeInterval(3600))), signedBy: h.rules, home: home)
        #expect(load(home).source == "cache")
    }
    @Test func theBuiltInRulesNeverExpire() {
        let past = RulesDocument(schema: 1, bot: "muse", revision: 1, profiles: BuiltinRules.document.profiles, keyId: nil, notAfter: "2001-01-01T00:00:00Z")
        let l = RulesStore.load(home: Fx.tempDir(), bot: "muse", trust: h.ctx, builtin: past)
        #expect(l.source == "builtin" && l.note == nil)
    }
    @Test func aMalformedNotAfterOrBotIsRejectedWhenDecoding() {
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", self.rulesJSON(rev: 2, notAfter: "tomorrow")) }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", self.rulesJSON(rev: 2, bot: "other")) }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "other", self.rulesJSON(rev: 2)) }
        #expect(throws: Never.self) { try RulesDocument.decode(bot: "other", self.rulesJSON(rev: 2, bot: "other")) }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "Not A Bot", self.rulesJSON(rev: 2, bot: "Not A Bot")) }
    }
    @Test func cacheFileNamesFollowTheBotNamespace() throws {
        let home = Fx.tempDir()
        let j = rulesJSON(rev: 5, bot: "other")
        try RulesStore.writeCache(json: j, signature: Keys.sign(j, h.rules.priv), home: home, bot: "other")
        #expect(RulesStore.cachePaths(home: home, bot: "other").json.lastPathComponent == "other.json")
        #expect(FileManager.default.fileExists(atPath: RulesStore.cachePaths(home: home, bot: "other").sig.path))
    }
}

@Suite struct RulesUpdaterHierarchyTests {
    let h = Hierarchy()
    let url = URL(string: "https://example.test/rules/muse.json")!
    var indexURL: URL { URL(string: "https://example.test/rules/index.json")! }

    func rules(rev: Int = 7, keyId: String? = "rules-1", notAfter: String? = nil) -> Data {
        Fx.json(RulesDocument(schema: 1, bot: "muse", revision: rev, profiles: BuiltinRules.document.profiles, keyId: keyId, notAfter: notAfter))
    }
    func index(bots: [String] = ["muse"], keyId: String? = "rules-1", rev: Int = 1) -> Data {
        var o: [String: Any] = ["schema": 1, "revision": rev, "bots": bots.map { ["id": $0, "rules": "\($0).json"] }]
        if let k = keyId { o["key_id"] = k }
        return h.bytes(o)
    }
    /// Serves each URL string with a body and a signature made by `signer`.
    func server(_ files: [URL: (Data, Keys.Pair)], log: Log = Log()) -> Fetcher {
        { u in
            log.urls.append(u.absoluteString)
            for (base, (body, signer)) in files {
                if u == base { return .success(body) }
                if u.absoluteString == base.absoluteString + ".sig" { return .success(Data(Keys.sign(body, signer.priv).utf8)) }
            }
            return .failure(FetchFailure("HTTP 404"))
        }
    }
    final class Log { var urls: [String] = [] }
    func update(_ f: @escaping Fetcher, home: URL, ctx: TrustContext? = nil, url: URL? = nil) -> RulesUpdateOutcome {
        RulesUpdater.update(url: url ?? self.url, home: home, bot: "muse", trust: ctx ?? h.ctx, builtin: BuiltinRules.document, fetch: f)
    }

    @Test func rulesSignedByTheRulesKeyAreInstalledAndTheOutcomeNamesTheKey() {
        let home = Fx.tempDir()
        let o = update(server([url: (rules(), h.rules)]), home: home)
        #expect(o.updated && o.reason == "updated" && o.keyId == "rules-1" && o.fields["key_id"] as? String == "rules-1")
        #expect(RulesStore.load(home: home, bot: "muse", trust: h.ctx, builtin: BuiltinRules.document).keyId == "rules-1")
    }
    @Test func rulesSignedByTheRootOrTheBinaryKeyAreRefused() {
        for signer in [h.root, h.binary] {
            let o = update(server([url: (rules(), signer)]), home: Fx.tempDir())
            #expect(!o.updated && o.reason == "bad_signature")
        }
    }
    @Test func aKeyThatIsRevokedOrExpiredIsRefusedWithTheReasonInTheDetail() throws {
        let revoked = TrustContext(rootKey: h.root.pub, keyset: .valid(try Keyset.decode(h.bytes(h.keysetObject(revoked: ["rules-1"]))), source: "t"), now: h.now)
        let o = update(server([url: (rules(), h.rules)]), home: Fx.tempDir(), ctx: revoked)
        #expect(!o.updated && o.reason == "untrusted_key" && o.detail == "key_revoked")
    }
    @Test func rootSignedRulesWithoutKeyIdAreRefusedWhateverTheKeysetState() {
        for state in [KeysetState.absent, .invalid("bad_signature"), .valid(h.keyset, source: "t")] {
            let ctx = TrustContext(rootKey: h.root.pub, keyset: state, now: h.now)
            let o = update(server([url: (rules(keyId: nil), h.root)]), home: Fx.tempDir(), ctx: ctx)
            #expect(!o.updated && o.reason == "untrusted_key" && o.detail == "key_id_required")
        }
    }
    @Test func anExpiredKeysetRefusesRulesUpdatesWithAClearReason() {
        let ctx = TrustContext(rootKey: h.root.pub, keyset: .expired(h.keyset), now: h.now)
        let o = update(server([url: (rules(), h.rules)]), home: Fx.tempDir(), ctx: ctx)
        #expect(!o.updated && o.reason == "untrusted_key" && o.detail == "keyset_expired")
    }
    @Test func signedButExpiredRulesAreNotInstalled() {
        let o = update(server([url: (rules(notAfter: h.iso(h.now.addingTimeInterval(-10))), h.rules)]), home: Fx.tempDir())
        #expect(!o.updated && o.reason == "expired")
    }

    // The signed bot index: it tells the updater which rules file belongs to which bot.
    @Test func theIndexIsFetchedFirstAndItsEntryNamesTheRulesFile() {
        let log = Log()
        let o = update(server([indexURL: (index(), h.rules), url: (rules(), h.rules)], log: log), home: Fx.tempDir())
        #expect(o.updated)
        #expect(log.urls.first == indexURL.absoluteString)
    }
    @Test func aBotMissingFromTheIndexIsNotUpdated() {
        let o = update(server([indexURL: (index(bots: ["other"]), h.rules), url: (rules(), h.rules)]), home: Fx.tempDir())
        #expect(!o.updated && o.reason == "bot_not_listed")
    }
    @Test func anIndexWithABadSignatureStopsTheUpdate() {
        let o = update(server([indexURL: (index(), h.binary), url: (rules(), h.rules)]), home: Fx.tempDir())
        #expect(!o.updated && o.reason == "bad_signature" && o.detail?.contains("index") == true)
    }
    @Test func aMissingIndexFallsBackToTheConventionalPathNextToIt() {
        let o = update(server([url: (rules(), h.rules)]), home: Fx.tempDir())
        #expect(o.updated)
    }
    @Test func indexEntriesCannotPointOutsideTheirDirectory() throws {
        for bad in ["../x.json", "/etc/passwd", "a/b.json", "x.txt", ""] {
            let o: [String: Any] = ["schema": 1, "revision": 1, "bots": [["id": "muse", "rules": bad]]]
            #expect(throws: RulesError.self) { try RulesIndex.decode(self.h.bytes(o)) }
        }
        let ok = try RulesIndex.decode(index(bots: ["muse", "other"]))
        #expect(ok.entry(for: "other")?.rules == "other.json" && ok.entry(for: "nope") == nil && ok.keyId == "rules-1")
    }
}

@Suite struct RulesChannelTests {
    @Test func stableIsTheDefaultAndNextIsOptIn() {
        #expect(RulesUpdater.url(env: [:], bot: "muse").absoluteString == "https://raw.githubusercontent.com/qualixar/claude-bot-bridge/main/rules/muse.json")
        #expect(RulesUpdater.url(env: ["CBB_RULES_CHANNEL": "next"], bot: "muse").absoluteString == "https://raw.githubusercontent.com/qualixar/claude-bot-bridge/main/rules/next/muse.json")
        for other in ["", "stable", "NEXT ", "beta"] {
            #expect(RulesUpdater.url(env: ["CBB_RULES_CHANNEL": other], bot: "muse").absoluteString == RulesUpdater.defaultURL(bot: "muse"), "\(other)")
        }
    }
    @Test func anExplicitUrlWinsOverTheChannel() {
        #expect(RulesUpdater.url(env: ["CBB_RULES_URL": "http://127.0.0.1:9/x.json", "CBB_RULES_CHANNEL": "next"], bot: "muse").absoluteString == "http://127.0.0.1:9/x.json")
    }
    @Test func theChannelIsReportedByRulesShow() {
        #expect(RulesUpdater.channel(env: ["CBB_RULES_CHANNEL": "next"]) == "next")
        #expect(RulesUpdater.channel(env: [:]) == "stable")
    }
    @Test func theIndexSitsNextToTheRulesOfThatChannel() {
        let next = RulesUpdater.url(env: ["CBB_RULES_CHANNEL": "next"], bot: "muse")
        #expect(RulesUpdater.indexURL(for: next).absoluteString == "https://raw.githubusercontent.com/qualixar/claude-bot-bridge/main/rules/next/index.json")
    }
}
