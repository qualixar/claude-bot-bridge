import Testing
import Foundation
@testable import MuseAXCore

/// Replays every recorded accessibility tree in test-fixtures/trees/ against EVERY profile in rules/muse.json (the file
/// that gets published, not the compiled-in copy), so a rules change is checked against all trees before it ships.
/// A fixture states what each profile must make of its tree; a profile added to the rules must be added to each fixture.
/// CI sets CBB_REQUIRE_REPO_FILES=1, which turns "the repo files are missing" from a skip into a failure.
@Suite struct TreeReplayTests {
    struct Fixture {
        let name: String
        let doc: TreeDocument
        let expect: [String: Any]
    }

    static func required() -> Bool { ProcessInfo.processInfo.environment["CBB_REQUIRE_REPO_FILES"] == "1" }

    static func fixtures() throws -> [Fixture] {
        let dir = Fx.repoFile("plugin/bridge/muse/test-fixtures/trees")
        let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
        return try files.map { f in
            let data = try Data(contentsOf: dir.appendingPathComponent(f))
            let o = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            return Fixture(name: f, doc: try JSONDecoder().decode(TreeDocument.self, from: data), expect: o["expect"] as? [String: Any] ?? [:])
        }
    }

    static func rules() throws -> RulesDocument? {
        let url = Fx.repoFile("rules/muse.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try RulesDocument.decode(bot: "muse", try Data(contentsOf: url))
    }

    static func select(_ f: Fixture, _ rules: RulesDocument, version: String?) -> ProfileSelection? {
        ProfileSelector.select(version: version, profiles: rules.profiles, verifyMatched: true) { p in
            SendAnchors.forTypingIntoOpenChat(TreeProbe(root: f.doc.tree, profile: p).probeAnchors())
        }
    }

    @Test func thereAreRecordedTreesForEveryGenerationOfTheUi() throws {
        guard let rules = try Self.rules() else { #expect(!Self.required(), "rules/muse.json is missing"); return }
        let fx = try Self.fixtures()
        #expect(fx.count >= 3)
        let versions = Set(fx.compactMap(\.doc.museVersion))
        for p in rules.profiles {
            #expect(versions.contains { p.matches(version: $0) }, "no recorded tree for a version that profile \(p.id) covers")
        }
    }

    @Test func everyProfileMakesWhatEachFixtureSaysItMakesOfItsTree() throws {
        guard let rules = try Self.rules() else { #expect(!Self.required(), "rules/muse.json is missing"); return }
        for f in try Self.fixtures() {
            let per = f.expect["profiles"] as? [String: [String: Any]] ?? [:]
            for p in rules.profiles {
                guard let want = per[p.id] else { Issue.record("\(f.name): no expectation for profile \(p.id); record what it must do with this tree"); continue }
                let probe = TreeProbe(root: f.doc.tree, profile: p)
                #expect(probe.layout().rawValue == want["layout"] as? String, "\(f.name) × \(p.id): layout")
                #expect(probe.missingForTyping() == (want["missing"] as? [String] ?? ["?"]), "\(f.name) × \(p.id): anchors missing for typing")
            }
        }
    }

    @Test func theProfileChosenForTheRecordedVersionIsTheExpectedOneAndFullyMatches() throws {
        guard let rules = try Self.rules() else { #expect(!Self.required(), "rules/muse.json is missing"); return }
        for f in try Self.fixtures() {
            let want = f.expect["selected"] as? [String: String] ?? [:]
            let sel = try #require(Self.select(f, rules, version: f.doc.museVersion), "\(f.name): nothing selected")
            #expect(sel.kind.rawValue == want["kind"] && sel.profile.id == want["profile"], "\(f.name): selected \(sel.kind.rawValue) \(sel.profile.id)")
            #expect(sel.failedAnchors.isEmpty, "\(f.name): anchors missing for the profile chosen for its own version: \(sel.failedAnchors)")
        }
    }

    @Test func aFutureMuseVersionFallsBackToProbeModeAsTheFixtureExpects() throws {
        guard let rules = try Self.rules() else { #expect(!Self.required(), "rules/muse.json is missing"); return }
        for f in try Self.fixtures() {
            let want = f.expect["future_version"] as? [String: String] ?? [:]
            let sel = try #require(Self.select(f, rules, version: "99.0"), "\(f.name): nothing selected")
            #expect(sel.kind.rawValue == want["kind"] && sel.profile.id == want["profile"], "\(f.name): future version selected \(sel.kind.rawValue) \(sel.profile.id)")
        }
    }

    @Test func chatNamesAndTheOpenChatAreReadFromEachTree() throws {
        guard let rules = try Self.rules() else { #expect(!Self.required(), "rules/muse.json is missing"); return }
        for f in try Self.fixtures() {
            let sel = try #require(Self.select(f, rules, version: f.doc.museVersion))
            let probe = TreeProbe(root: f.doc.tree, profile: sel.profile)
            #expect(probe.chatNames() == (f.expect["chats"] as? [String]), "\(f.name): chat list")
            #expect(probe.currentChat() == f.expect["current_chat"] as? String, "\(f.name): open chat")
        }
    }

    @Test func recordedTreesAreRedactedAndCarryNoPrivateContent() throws {
        for f in try Self.fixtures() {
            #expect(f.doc.redacted && f.doc.format == TreeDocument.format, "\(f.name)")
            let json = T.json(f.doc.tree)
            // Every readable string is a known UI label, a hash or the message marker: nothing else may appear.
            func strings(_ n: TreeNode) -> [String] { [n.title, n.value, n.description].compactMap { $0 } + n.children.flatMap(strings) }
            let allowed = try Self.rules().map { r in r.profiles.flatMap { RedactionPolicy(profile: $0).allowlist } } ?? []
            let vocab = try Self.rules().map { r in r.profiles.flatMap { RedactionPolicy(profile: $0).vocabulary } } ?? []
            for s in strings(f.doc.tree) where !s.isEmpty && !s.hasPrefix("h:") && s != Redactor.droppedMarker && !allowed.contains(s) {
                let words = s.split(separator: " ").map(String.init)
                #expect(words.allSatisfy { $0.hasPrefix("h:") || vocab.contains($0) }, "\(f.name): unexpected readable string \"\(s)\"")
            }
            #expect(!json.isEmpty)
        }
    }
}
