import Foundation
import MuseAXCore

/// `muse-ax doctor [--dump-tree [path]] [--text]`: read-only. Reports versions, layout, anchors, rules and key state,
/// lock state and the last sends; with --dump-tree also writes a redacted accessibility tree and prints a draft profile.
enum DoctorCommand {
    static func run(bot: BotDriver, dump: DumpTarget?) throws -> [String: Any] {
        let home = RulesStore.home()
        let facts = DoctorFacts(bot: bot.id, binaryVersion: BridgeInfo.version, app: bot.diagnostics(), rulesChannel: RulesUpdater.channel(),
                                keyset: LiveTrust.context(home: home).keyset, lock: UILock.state(home: home),
                                sends: SendJournal.read(home: home, last: DoctorReport.lastSendsShown))
        var out = DoctorReport.fields(facts)
        guard let dump = dump else { return out }
        let url = target(dump, home: home, version: facts.app.versionShort)
        let r = try bot.dumpTree(to: url)
        out["dump_tree"] = ["path": r.path.path, "nodes": r.nodes, "hashed_strings": r.hashed, "dropped_strings": r.dropped,
                            "kept_strings": r.kept, "truncated": r.truncated, "redacted": true]
        out["draft_profile"] = r.draftProfile
        out["draft_notes"] = r.notes
        return out
    }

    static func target(_ d: DumpTarget, home: URL, version: String?, now: Date = Date()) -> URL {
        switch d {
        case .path(let p): return URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        case .defaultPath:
            let stamp = Int(now.timeIntervalSince1970)
            return home.appendingPathComponent("doctor").appendingPathComponent("tree-\(version ?? "unknown")-\(stamp).json")
        }
    }
}
