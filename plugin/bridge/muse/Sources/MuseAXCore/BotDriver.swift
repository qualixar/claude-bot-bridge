import Foundation

/// What `muse-ax doctor` learns about the app from a bot driver (everything else in the report is bot-independent).
public struct AppDiagnostics {
    public var running: Bool
    public var axTrusted: Bool
    public var versionShort: String?
    public var versionBuild: String?
    public var layout: String?
    /// Anchor name -> found, for the profile that was selected.
    public var anchors: [(String, Bool)]
    public var windowWidth: Int?
    public var windowHeight: Int?
    public var profile: String?
    public var versionCheck: String?
    public var rulesSource: String?
    public var rulesRevision: Int?
    public var rulesKeyId: String?
    public var rulesNote: String?
    public var verifiedVersions: [String]

    public static let notRunning = AppDiagnostics(running: false, axTrusted: false, versionShort: nil, versionBuild: nil, layout: nil,
                                                  anchors: [], windowWidth: nil, windowHeight: nil, profile: nil, versionCheck: nil,
                                                  rulesSource: nil, rulesRevision: nil, rulesKeyId: nil, rulesNote: nil, verifiedVersions: [])
    public init(running: Bool, axTrusted: Bool, versionShort: String?, versionBuild: String?, layout: String?, anchors: [(String, Bool)],
                windowWidth: Int?, windowHeight: Int?, profile: String?, versionCheck: String?, rulesSource: String?, rulesRevision: Int?,
                rulesKeyId: String?, rulesNote: String?, verifiedVersions: [String]) {
        self.running = running; self.axTrusted = axTrusted; self.versionShort = versionShort; self.versionBuild = versionBuild
        self.layout = layout; self.anchors = anchors; self.windowWidth = windowWidth; self.windowHeight = windowHeight
        self.profile = profile; self.versionCheck = versionCheck; self.rulesSource = rulesSource; self.rulesRevision = rulesRevision
        self.rulesKeyId = rulesKeyId; self.rulesNote = rulesNote; self.verifiedVersions = verifiedVersions
    }
}

/// The boundary between the bridge (rules, keys, locks, journal, idle guard, JSON output) and one specific bot app.
/// Everything that knows how a particular app looks or behaves lives behind this protocol; `MuseDriver` is the only
/// implementation. A second bot adds a driver, a rules file `rules/<id>.json` listed in `rules/index.json`, and a
/// `bots/<id>.js` module on the MCP side.
public protocol BotDriver {
    /// Short lowercase name: the `bot` of its rules documents, the key in the registries ("muse").
    var id: String { get }
    /// The macOS bundle id of the app this driver drives.
    var bundleID: String { get }
    /// Stem of the rules file (`rules/<namespace>.json`) and of the cached copy.
    var rulesNamespace: String { get }
    /// The rules compiled into the binary for this bot.
    var builtinRules: RulesDocument { get }

    /// Chooses the profile for the running app version (version match first, then probing).
    func selectProfile(version: String?, profiles: [Profile], verifyMatched: Bool, probe: (Profile) -> [(String, Bool)]) -> ProfileSelection?

    func status() -> [String: Any]
    func chats() throws -> [String: Any]
    func open(chat: String) throws -> [String: Any]
    func read(chat: String?, last: Int?) throws -> [String: Any]
    func send(chat: String, text: String, dryRun: Bool) throws -> [String: Any]
    /// Optional: a bot without side chats keeps the default, which refuses.
    func newSideChat() throws -> [String: Any]
    func waitReply(chat: String, timeout: Double) throws -> [String: Any]
    func selftest() throws -> [String: Any]
    func isRunning() -> Bool
    /// Version of the running app, nil when it is not running or unreadable (the canary compares it over time).
    func runningVersion() -> String?
    /// Read-only facts for `doctor`.
    func diagnostics() -> AppDiagnostics
    /// Read-only: writes a REDACTED accessibility tree to `url`.
    func dumpTree(to url: URL) throws -> TreeDumpResult
}

extension BotDriver {
    public func newSideChat() throws -> [String: Any] { throw MuseError.refused("\(id) has no side chats") }
}

/// The drivers this binary contains, by id.
public struct BotRegistry {
    private let byID: [String: BotDriver]
    public let ids: [String]
    public let defaultID: String

    public init(_ drivers: [BotDriver], defaultID: String) {
        precondition(drivers.contains { $0.id == defaultID }, "the default bot must be registered")
        precondition(drivers.allSatisfy { RulesDocument.isValidBotID($0.id) && $0.rulesNamespace == $0.id }, "bot ids must be valid and equal their rules namespace")
        byID = Dictionary(uniqueKeysWithValues: drivers.map { ($0.id, $0) })
        ids = drivers.map(\.id)
        self.defaultID = defaultID
    }

    /// CBB_BOT picks the bot; without it the default driver is used.
    public func resolve(env: [String: String] = ProcessInfo.processInfo.environment) throws -> BotDriver {
        let wanted = env["CBB_BOT"].flatMap { $0.isEmpty ? nil : $0 } ?? defaultID
        guard let d = byID[wanted] else {
            throw MuseError.invalidArgument("unknown bot \"\(wanted)\" (CBB_BOT). Known bots: \(ids.joined(separator: ", ")).")
        }
        return d
    }
}
