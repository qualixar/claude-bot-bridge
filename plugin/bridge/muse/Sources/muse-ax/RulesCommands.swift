import Foundation
import MuseAXCore

/// `muse-ax rules update|show`. Neither needs the app to be running, and neither ever fails hard.
enum RulesCommands {
    /// The keyset is refreshed first (it decides which rules keys are trusted), then the rules of this bot.
    static func update(bot: BotDriver) -> [String: Any] {
        let home = RulesStore.home()
        let env = ProcessInfo.processInfo.environment
        var keyset: [String: Any] = ["updated": false, "reason": "skipped", "detail": "a custom CBB_RULES_URL is set and no CBB_KEYSET_URL"]
        if let kurl = KeysetUpdater.url(env: env) {
            keyset = KeysetUpdater.update(url: kurl, home: home, rootKey: activeRootKey(), bundled: LiveTrust.bundledKeyset(),
                                           fetch: { LiveFetcher.fetch($0, maxBytes: KeysetUpdater.maxBytes) }).fields
        }
        let rules = RulesUpdater.update(url: RulesUpdater.url(env: env, bot: bot.rulesNamespace), home: home, bot: bot.rulesNamespace,
                                        trust: LiveTrust.context(home: home), builtin: bot.builtinRules,
                                        fetch: { LiveFetcher.fetch($0, maxBytes: RulesUpdater.maxBytes) })
        var out = rules.fields
        out["keyset"] = keyset
        return out
    }

    static func show(bot: BotDriver) -> [String: Any] {
        let home = RulesStore.home()
        let trust = LiveTrust.context(home: home)
        let r = RulesStore.load(home: home, bot: bot.rulesNamespace, trust: trust, builtin: bot.builtinRules)
        var out: [String: Any] = [
            "bot": bot.id, "source": r.source, "revision": r.revision, "channel": RulesUpdater.channel(),
            "profiles": r.document.profiles.map { ["id": $0.id, "versions": $0.match.versions] as [String: Any] },
            "cache_path": RulesStore.cachePaths(home: home, bot: bot.rulesNamespace).json.path,
            "update_url": RulesUpdater.url(bot: bot.rulesNamespace).absoluteString,
            "keyset": DoctorReport.keysetFields(trust.keyset),
        ]
        if let k = r.keyId { out["key_id"] = k }
        if let n = r.note { out["note"] = n }
        return out
    }
}
