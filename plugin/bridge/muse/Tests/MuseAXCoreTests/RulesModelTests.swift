import Testing
import Foundation
@testable import MuseAXCore

@Suite struct RulesModelTests {
    @Test func builtinDocumentIsValidAndHasBothProfiles() throws {
        let d = BuiltinRules.document
        #expect(d.schema == 1 && d.bot == "muse" && d.revision >= 1)
        #expect(d.profiles.map(\.id) == ["muse-12.1", "muse-13.1"])
        _ = try RulesDocument.decode(bot: "muse", Data(BuiltinRules.json.utf8))
    }
    @Test func builtinMatchesRulesFileInRepo() throws {
        let url = Fx.repoFile("rules/muse.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return }  // plugin installed without the repo root
        let fromFile = try RulesDocument.decode(bot: "muse", try Data(contentsOf: url))
        #expect(fromFile == BuiltinRules.document, "run plugin/scripts/sync-builtin-rules.sh")
    }
    @Test func layoutDetection() {
        #expect(Fx.p13.detectLayout { $0 == "sidebar" } == .sidebar)
        #expect(Fx.p13.detectLayout { $0 == "switcher" } == .chatSwitcher)
        #expect(Fx.p13.detectLayout { _ in true } == .sidebar)
        #expect(Fx.p13.detectLayout { _ in false } == .unknown)
    }
    @Test func requiredElementsDependOnLayout() {
        #expect(Fx.p12.requiredElements(layout: .sidebar) == ["web_area", "chat_messages_group", "composer", "main_chat_button", "new_side_chat_button"])
        #expect(Fx.p12.requiredElements(layout: .chatSwitcher) == ["web_area", "chat_messages_group", "composer"])
        #expect(ChatListLayout.sidebar.rawValue == "sidebar" && ChatListLayout.chatSwitcher.rawValue == "chat_switcher")
    }
    @Test func profileMatching() {
        #expect(Fx.p12.matches(version: "12.1") && !Fx.p12.matches(version: "13.1"))
        #expect(Fx.p13.matches(version: "13.1") && Fx.p13.matches(version: "13.1.4"))
        #expect(!Fx.p13.matches(version: "13.0") && !Fx.p13.matches(version: "13.2"))
        #expect(!Fx.p13.matches(version: "garbage"))
    }
}

@Suite struct RulesDecodeTests {
    func mutated(_ f: (inout [String: Any]) -> Void) -> Data {
        var o = try! JSONSerialization.jsonObject(with: Data(BuiltinRules.json.utf8)) as! [String: Any]
        f(&o)
        return try! JSONSerialization.data(withJSONObject: o)
    }
    func profiles(_ o: [String: Any]) -> [[String: Any]] { o["profiles"] as! [[String: Any]] }

    @Test func newerSchemaIsReportedNotCrashed() {
        let d = mutated { $0["schema"] = 2; $0["profiles"] = "totally different shape" }
        #expect(RulesDocument.peekSchema(d) == 2)
        #expect(throws: RulesError.schemaUnsupported(2)) { try RulesDocument.decode(bot: "muse", d) }
    }
    @Test func rejectsGarbage() {
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", Data("not json".utf8)) }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", Data(BuiltinRules.json.utf8.prefix(300))) }
        #expect(RulesDocument.peekSchema(Data("nope".utf8)) == nil)
    }
    @Test func rejectsWrongBotAndEmptyProfiles() {
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", self.mutated { $0["bot"] = "other" }) }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", self.mutated { $0["profiles"] = [Any]() }) }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", self.mutated { $0["revision"] = 0 }) }
    }
    @Test func rejectsBadProfiles() {
        let dupe = mutated { o in let p = self.profiles(o); o["profiles"] = [p[0], p[0]] }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", dupe) }
        let badSpec = mutated { o in var p = self.profiles(o); p[0]["match"] = ["versions": ["13.x"]]; o["profiles"] = p }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", badSpec) }
        let badRef = mutated { o in
            var p = self.profiles(o); var a = p[0]["anchors"] as! [String: Any]
            a["required"] = ["composer", "no_such_element"]; p[0]["anchors"] = a; o["profiles"] = p
        }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", badRef) }
        let badRegex = mutated { o in
            var p = self.profiles(o); var m = p[0]["messages"] as! [String: Any]
            m["timePattern"] = "(unclosed"; p[0]["messages"] = m; o["profiles"] = p
        }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", badRegex) }
        let noComposer = mutated { o in
            var p = self.profiles(o); var e = p[0]["elements"] as! [String: Any]
            e.removeValue(forKey: "composer"); p[0]["elements"] = e; o["profiles"] = p
        }
        #expect(throws: RulesError.self) { try RulesDocument.decode(bot: "muse", noComposer) }
    }
    @Test func unknownKeysAreIgnoredForForwardCompatibility() throws {
        let d = mutated { $0["note"] = "added later"; $0["extra"] = ["a": 1] }
        #expect(try RulesDocument.decode(bot: "muse", d) == BuiltinRules.document)
    }
}

@Suite struct ProfileSelectorTests {
    let all = [Fx.p12, Fx.p13]
    func allFound(_ p: Profile) -> [(String, Bool)] { [("composer", true)] }
    func failing(_ names: [String]) -> (Profile) -> [(String, Bool)] { { _ in names.map { ($0, false) } } }

    @Test func versionMatchWinsWithoutProbing() {
        var probed = 0
        let s = ProfileSelector.select(version: "12.1", profiles: all) { _ in probed += 1; return [] }!
        #expect(s.kind == .matched && s.profile.id == "muse-12.1" && s.failedAnchors.isEmpty && probed == 0)
        #expect(ProfileSelector.select(version: "13.1", profiles: all, probe: allFoundClosure)!.profile.id == "muse-13.1")
    }
    func allFoundClosure(_ p: Profile) -> [(String, Bool)] { allFound(p) }

    @Test func unmatchedVersionProbesNewestFirst() {
        var order: [String] = []
        let s = ProfileSelector.select(version: "14.0", profiles: all) { p in order.append(p.id); return [("composer", true)] }!
        #expect(s.kind == .probe && s.profile.id == "muse-13.1" && order == ["muse-13.1"])
    }
    @Test func probeSkipsProfilesWithMissingAnchors() {
        let s = ProfileSelector.select(version: "14.0", profiles: all) { p in
            p.id == "muse-13.1" ? [("composer", false)] : [("composer", true)]
        }!
        #expect(s.kind == .probe && s.profile.id == "muse-12.1")
    }
    @Test func noMatchAndProbeFailureYieldsNoneWithFewestFailures() {
        let s = ProfileSelector.select(version: "14.0", profiles: all) { p in
            p.id == "muse-12.1" ? [("composer", false), ("web_area", true)] : [("composer", false), ("web_area", false)]
        }!
        #expect(s.kind == .none && s.profile.id == "muse-12.1" && s.failedAnchors == ["composer"])
    }
    @Test func unknownVersionStillProbes() {
        #expect(ProfileSelector.select(version: nil, profiles: all, probe: allFoundClosure)!.kind == .probe)
    }
    @Test func verifyMatchedFallsThroughWhenMatchedProfileAnchorsFail() {
        let s = ProfileSelector.select(version: "13.1", profiles: all, verifyMatched: true) { p in
            p.id == "muse-13.1" ? [("composer", false)] : [("composer", true)]
        }!
        #expect(s.kind == .probe && s.profile.id == "muse-12.1")
        let ok = ProfileSelector.select(version: "13.1", profiles: all, verifyMatched: true, probe: allFoundClosure)!
        #expect(ok.kind == .matched && ok.profile.id == "muse-13.1")
        let none = ProfileSelector.select(version: "13.1", profiles: all, verifyMatched: true, probe: failing(["composer"]))!
        #expect(none.kind == .none && none.failedAnchors == ["composer"])
    }
    @Test func emptyProfilesGiveNil() {
        #expect(ProfileSelector.select(version: "1", profiles: [], probe: allFoundClosure) == nil)
    }
}

@Suite struct VersionCheckLabelTests {
    @Test func labels() {
        #expect(ProfileSelection(kind: .matched, profile: Fx.p13, failedAnchors: []).versionCheck(version: "13.1") == "verified")
        #expect(ProfileSelection(kind: .probe, profile: Fx.p13, failedAnchors: []).versionCheck(version: "14.0") == "probe")
        #expect(ProfileSelection(kind: .none, profile: Fx.p13, failedAnchors: ["x"]).versionCheck(version: "14.0") == "unverified")
        #expect(ProfileSelection(kind: .none, profile: Fx.p13, failedAnchors: ["x"]).versionCheck(version: nil) == "unknown")
    }
}
