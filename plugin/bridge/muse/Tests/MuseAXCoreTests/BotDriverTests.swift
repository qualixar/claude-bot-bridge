import Testing
import Foundation
@testable import MuseAXCore

/// A second bot, to prove nothing below the driver boundary is tied to Muse.
struct OtherBotDriver: BotDriver {
    let id: String
    var bundleID: String { "test.\(id)" }
    var rulesNamespace: String { id }
    var builtinRules: RulesDocument { RulesDocument(schema: 1, bot: id, revision: 1, profiles: BuiltinRules.document.profiles) }
    func selectProfile(version: String?, profiles: [Profile], verifyMatched: Bool, probe: (Profile) -> [(String, Bool)]) -> ProfileSelection? {
        ProfileSelector.select(version: version, profiles: profiles, verifyMatched: verifyMatched, probe: probe)
    }
    func status() -> [String: Any] { ["bot": id] }
    func chats() throws -> [String: Any] { ["chats": [String]()] }
    func open(chat: String) throws -> [String: Any] { ["opened": chat] }
    func read(chat: String?, last: Int?) throws -> [String: Any] { ["chat": chat as Any? ?? NSNull()] }
    func send(chat: String, text: String, dryRun: Bool) throws -> [String: Any] { ["sent": !dryRun] }
    func waitReply(chat: String, timeout: Double) throws -> [String: Any] { [:] }
    func selftest() throws -> [String: Any] { ["checks": [String: Bool]()] }
    func isRunning() -> Bool { false }
    func runningVersion() -> String? { nil }
    func diagnostics() -> AppDiagnostics { .notRunning }
    func dumpTree(to url: URL) throws -> TreeDumpResult { throw MuseError.refused("fake") }
}

@Suite struct BotRegistryTests {
    let reg = BotRegistry([OtherBotDriver(id: "alpha"), OtherBotDriver(id: "beta")], defaultID: "alpha")

    @Test func resolvesByIdAndFallsBackToTheDefault() throws {
        #expect(try reg.resolve(env: [:]).id == "alpha")
        #expect(try reg.resolve(env: ["CBB_BOT": "beta"]).id == "beta")
        #expect(try reg.resolve(env: ["CBB_BOT": ""]).id == "alpha")
    }
    @Test func anUnknownBotIsAnArgumentErrorThatListsTheKnownOnes() {
        do { _ = try reg.resolve(env: ["CBB_BOT": "gamma"]); Issue.record("should throw") }
        catch let e as MuseError {
            #expect(e.code == "invalid_argument" && e.message.contains("gamma") && e.message.contains("alpha") && e.message.contains("beta"))
        } catch { Issue.record("wrong error") }
    }
    @Test func driverIdsMustBeValidAndTheRulesNamespaceFollowsTheId() {
        for d in [OtherBotDriver(id: "alpha")] {
            #expect(RulesDocument.isValidBotID(d.id) && d.rulesNamespace == d.id && d.builtinRules.bot == d.rulesNamespace)
        }
        #expect(reg.ids == ["alpha", "beta"])
    }
    @Test func rulesAndKeysAreIndependentOfTheBot() throws {
        // The same trust and store code serves another bot: its own file names, its own bot check.
        let home = Fx.tempDir(), h = Hierarchy()
        let d = OtherBotDriver(id: "alpha")
        let json = Fx.json(RulesDocument(schema: 1, bot: "alpha", revision: 3, profiles: BuiltinRules.document.profiles, keyId: "rules-1"))
        try RulesStore.writeCache(json: json, signature: Keys.sign(json, h.rules.priv), home: home, bot: d.rulesNamespace)
        let l = RulesStore.load(home: home, bot: d.rulesNamespace, trust: h.ctx, builtin: d.builtinRules)
        #expect(l.source == "cache" && l.document.bot == "alpha")
        // Muse's loader refuses alpha's document: wrong bot.
        #expect(RulesStore.load(home: home, bot: "muse", trust: h.ctx, builtin: BuiltinRules.document).source == "builtin")
    }
}

/// Nothing outside the Muse driver may know what Muse is: not its bundle id, not a hard-coded "muse" bot check.
@Suite struct DriverBoundaryTests {
    static let driverFiles: Set<String> = ["MuseDriver.swift", "AX.swift", "Muse.swift", "Session.swift", "Send.swift", "SendCommand.swift", "TreeCapture.swift"]

    func swiftFiles(_ sub: String) -> [URL] {
        let dir = Fx.repoFile("plugin/bridge/muse/Sources/\(sub)")
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
        return (e?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }
    }

    @Test func theCoreNeverNamesMuseTheBundleIdOrABotLiteral() throws {
        let files = swiftFiles("MuseAXCore").filter { $0.lastPathComponent != "BuiltinRulesData.swift" }
        guard !files.isEmpty else { return }   // plugin installed without the sources
        for f in files {
            let text = try String(contentsOf: f, encoding: .utf8)
            #expect(!text.contains("com.meta.endo"), "\(f.lastPathComponent) names the Muse bundle id")
            #expect(!text.contains("== \"muse\"") && !text.contains("bot: \"muse\""), "\(f.lastPathComponent) hard-codes the muse bot")
        }
    }
    @Test func theExecutableKnowsMuseOnlyInsideTheDriverFiles() throws {
        let files = swiftFiles("muse-ax")
        guard !files.isEmpty else { return }
        for f in files where !Self.driverFiles.contains(f.lastPathComponent) {
            let text = try String(contentsOf: f, encoding: .utf8)
            #expect(!text.contains("com.meta.endo"), "\(f.lastPathComponent) names the Muse bundle id")
            #expect(!text.contains("MuseApp") && !text.contains("MuseSession"), "\(f.lastPathComponent) reaches into the Muse driver internals")
        }
    }
    @Test func theRegistryHoldsExactlyTheDriverFilesSayItDoes() throws {
        let commands = Fx.repoFile("plugin/bridge/muse/Sources/muse-ax/Commands.swift")
        guard FileManager.default.fileExists(atPath: commands.path) else { return }
        let text = try String(contentsOf: commands, encoding: .utf8)
        #expect(text.contains("BotRegistry([MuseDriver()], defaultID: MuseDriver.id)"))
    }
}
