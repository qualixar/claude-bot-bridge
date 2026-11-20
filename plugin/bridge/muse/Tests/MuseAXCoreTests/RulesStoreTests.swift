import Testing
import Foundation
import CryptoKit
@testable import MuseAXCore

@Suite struct RulesStoreTests {
    let k = Keys.fresh()

    func writeCache(_ d: RulesDocument, home: URL, signWith key: Curve25519.Signing.PrivateKey? = nil) throws {
        let json = Fx.json(d)
        try RulesStore.writeCache(json: json, signature: Keys.sign(json, key ?? k.priv), home: home, bot: "muse")
    }

    @Test func noCacheUsesBuiltin() {
        let l = RulesStore.load(home: Fx.tempDir(), bot: "muse", trust: .rules(k), builtin: BuiltinRules.document)
        #expect(l.source == "builtin" && l.document == BuiltinRules.document && l.note == nil)
    }
    @Test func validNewerCacheWins() throws {
        let home = Fx.tempDir(); try writeCache(Fx.doc(revision: 5), home: home)
        let l = RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document)
        #expect(l.source == "cache" && l.revision == 5)
    }
    @Test func equalRevisionCacheWinsTie() throws {
        let home = Fx.tempDir(); try writeCache(Fx.doc(revision: BuiltinRules.document.revision), home: home)
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).source == "cache")
    }
    @Test func cacheOlderThanBuiltinIsIgnored() throws {
        let home = Fx.tempDir(); try writeCache(Fx.doc(revision: 1), home: home)
        // Pretend the binary ships a newer built-in than the cache.
        var newer = BuiltinRules.document; newer = RulesDocument(schema: 1, bot: "muse", revision: 9, profiles: newer.profiles)
        let l = RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: newer)
        #expect(l.source == "builtin" && l.revision == 9 && l.note == "cache_older_than_builtin")
    }
    @Test func badSignatureFallsBackToBuiltin() throws {
        let home = Fx.tempDir()
        try writeCache(Fx.doc(revision: 5), home: home, signWith: Keys.fresh().priv)
        let l = RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document)
        #expect(l.source == "builtin" && l.note == "cache_bad_signature")
    }
    @Test func tamperedCacheFallsBackToBuiltin() throws {
        let home = Fx.tempDir(); try writeCache(Fx.doc(revision: 5), home: home)
        let json = RulesStore.cachePaths(home: home, bot: "muse").json
        var bytes = try Data(contentsOf: json); bytes.append(contentsOf: Array(" ".utf8))
        try bytes.write(to: json)
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).note == "cache_bad_signature")
    }
    @Test func missingSignatureFileFallsBack() throws {
        let home = Fx.tempDir(); try writeCache(Fx.doc(revision: 5), home: home)
        try FileManager.default.removeItem(at: RulesStore.cachePaths(home: home, bot: "muse").sig)
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).source == "builtin")
    }
    @Test func signedButInvalidRulesFallBack() throws {
        let home = Fx.tempDir()
        let bad = Data(#"{"schema":2,"bot":"muse","key_id":"rules-1"}"#.utf8)
        try RulesStore.writeCache(json: bad, signature: Keys.sign(bad, k.priv), home: home, bot: "muse")
        let l = RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document)
        #expect(l.source == "builtin" && l.note == "cache_invalid")
    }
    @Test func homeFromEnv() {
        #expect(RulesStore.home(env: ["CBB_HOME": "/x/y"]).path == "/x/y")
        #expect(RulesStore.home(env: [:]).path.hasSuffix("/.claude-bot-bridge"))
        #expect(RulesStore.home(env: ["CBB_HOME": ""]).path.hasSuffix("/.claude-bot-bridge"))
    }
}

@Suite struct StateStoreTests {
    @Test func mergeKeepsUnknownKeysAndOverwritesGivenOnes() throws {
        let home = Fx.tempDir()
        try StateStore.merge(["a": 1, "keep": "x"], home: home)
        try StateStore.merge(["a": 2, "b": ["n": true]], home: home)
        let s = StateStore.read(home: home)
        #expect(s["a"] as? Int == 2 && s["keep"] as? String == "x" && (s["b"] as? [String: Any])?["n"] as? Bool == true)
    }
    @Test func missingOrCorruptFileReadsAsEmpty() throws {
        let home = Fx.tempDir()
        #expect(StateStore.read(home: home).isEmpty)
        try Data("{broken".utf8).write(to: home.appendingPathComponent("state.json"))
        #expect(StateStore.read(home: home).isEmpty)
        try StateStore.merge(["a": 1], home: home)
        #expect(StateStore.read(home: home)["a"] as? Int == 1)
    }
}

@Suite struct RulesCacheAtomicityTests {
    let k = Keys.fresh()
    func write(_ rev: Int, home: URL) throws {
        let json = Fx.json(Fx.doc(revision: rev))
        try RulesStore.writeCache(json: json, signature: Keys.sign(json, k.priv), home: home, bot: "muse")
    }

    @Test func jsonAndSignatureLiveInOneDirectoryBehindOneSymlink() throws {
        let home = Fx.tempDir(); try write(5, home: home)
        let rules = home.appendingPathComponent("rules")
        let link = try FileManager.default.destinationOfSymbolicLink(atPath: rules.appendingPathComponent("current").path)
        #expect(link.hasPrefix("v-"))
        let dir = rules.appendingPathComponent(link)
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("muse.json").path))
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("muse.json.sig").path))
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).revision == 5)
    }
    @Test func updateSwapsToANewDirectoryAndKeepsOnlyOneOlder() throws {
        let home = Fx.tempDir()
        for r in 5...9 { try write(r, home: home) }
        let rules = home.appendingPathComponent("rules")
        let dirs = try FileManager.default.contentsOfDirectory(atPath: rules.path).filter { $0.hasPrefix("v-") }
        #expect(dirs.count == 2)
        #expect(RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document).revision == 9)
    }
    @Test func aReaderNeverSeesAMismatchedPairWhileWritersRace() throws {
        let home = Fx.tempDir(); try write(5, home: home)
        let trust = TrustContext.rules(k)
        let bad = LockedCounter()
        DispatchQueue.concurrentPerform(iterations: 40) { i in
            if i % 2 == 0 { try? write(6 + i, home: home) }
            else if RulesStore.load(home: home, bot: "muse", trust: trust, builtin: BuiltinRules.document).note == "cache_bad_signature" { bad.bump() }
        }
        #expect(bad.value == 0)
        #expect(RulesStore.load(home: home, bot: "muse", trust: trust, builtin: BuiltinRules.document).source == "cache")
    }
    @Test func writersSerializeOnTheLockFile() throws {
        let home = Fx.tempDir()
        DispatchQueue.concurrentPerform(iterations: 8) { i in try? write(10 + i, home: home) }
        let l = RulesStore.load(home: home, bot: "muse", trust: .rules(k), builtin: BuiltinRules.document)
        #expect(l.source == "cache" && (10...17).contains(l.revision))
        #expect(!FileManager.default.fileExists(atPath: home.appendingPathComponent("rules/.lock").path))
    }
}

final class LockedCounter: @unchecked Sendable {
    private let l = NSLock(); private var n = 0
    func bump() { l.lock(); n += 1; l.unlock() }
    var value: Int { l.lock(); defer { l.unlock() }; return n }
}

@Suite struct FileLockTests {
    func lockURL() -> URL { Fx.tempDir("lock").appendingPathComponent("x.lock") }
    func age(_ u: URL, seconds: TimeInterval) throws {
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -seconds)], ofItemAtPath: u.path)
    }

    @Test func recordsPidAndNonceAndExcludesASecondOwner() throws {
        let u = lockURL()
        let a = try #require(FileLock.acquire(at: u))
        let body = try String(contentsOf: u, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(body.count == 2 && body[0] == String(getpid()) && body[1].count >= 16)
        #expect(FileLock.acquire(at: u) == nil)
        a.release()
        #expect(!FileManager.default.fileExists(atPath: u.path))
        #expect(FileLock.acquire(at: u) != nil)
    }
    @Test func releaseNeverRemovesSomeoneElsesLock() throws {
        let u = lockURL()
        let a = try #require(FileLock.acquire(at: u))
        try Data("4242\nnot-our-nonce\n".utf8).write(to: u)
        a.release()
        #expect(FileManager.default.fileExists(atPath: u.path))
    }
    @Test func aLiveOwnerIsNeverTakenOverHoweverOld() throws {
        let u = lockURL()
        _ = try #require(FileLock.acquire(at: u))
        try age(u, seconds: 3600)
        #expect(FileLock.acquire(at: u, staleAfter: 60, isAlive: { _ in true }) == nil)
    }
    @Test func aDeadButYoungOwnerIsNotTakenOver() throws {
        let u = lockURL()
        _ = try #require(FileLock.acquire(at: u))
        #expect(FileLock.acquire(at: u, staleAfter: 60, isAlive: { _ in false }) == nil)
    }
    @Test func deadAndOldOwnerIsTakenOver() throws {
        let u = lockURL()
        _ = try #require(FileLock.acquire(at: u))
        try age(u, seconds: 3600)
        let b = try #require(FileLock.acquire(at: u, staleAfter: 60, isAlive: { _ in false }))
        let body = try String(contentsOf: u, encoding: .utf8)
        #expect(body.hasPrefix(String(getpid()) + "\n"))
        b.release()
        #expect(!FileManager.default.fileExists(atPath: u.path))
    }
    @Test func unreadableOwnerCountsAsDeadOnceOld() throws {
        let u = lockURL()
        try Data("garbage".utf8).write(to: u)
        #expect(FileLock.acquire(at: u, staleAfter: 60) == nil)
        try age(u, seconds: 3600)
        #expect(FileLock.acquire(at: u, staleAfter: 60) != nil)
    }
    @Test func theRealLivenessCheckSeesThisProcessAndAMissingOne() {
        #expect(FileLock.processAlive(getpid()))
        #expect(!FileLock.processAlive(Int32.max - 7))
    }
}
