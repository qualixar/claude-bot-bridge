import Foundation

public struct LoadedRules {
    public let document: RulesDocument
    /// "cache" (downloaded, signature verified) or "builtin" (compiled into the binary).
    public let source: String
    public var revision: Int { document.revision }
    /// The keyset key that signed the cached rules; nil for the built-in rules.
    public let keyId: String?
    /// Why the cache was not used, when it exists but was ignored (`cache_<reason>`).
    public let note: String?

    public init(document: RulesDocument, source: String, keyId: String? = nil, note: String?) {
        self.document = document; self.source = source; self.keyId = keyId; self.note = note
    }
}

public enum RulesStore {
    public static func home(env: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let h = env["CBB_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude-bot-bridge")
    }

    /// The cache directory holds one pair (`<bot>.json` and `<bot>.json.sig`) behind the `current` symlink.
    static func cache(_ home: URL, bot: String) -> PairCache { PairCache(root: home.appendingPathComponent("rules"), fileName: "\(bot).json") }

    public static func cachePaths(home: URL, bot: String) -> (json: URL, sig: URL) { cache(home, bot: bot).currentPaths }

    /// Cached rules win when their detached signature is trusted (see `Trust`), they decode for this bot, they have not
    /// passed their `not_after`, and they are at least as new as the built-in rules; otherwise the built-in rules
    /// are used (they never expire).
    public static func load(home: URL, bot: String, trust: TrustContext, builtin: RulesDocument) -> LoadedRules {
        let fallback = { (note: String?) in LoadedRules(document: builtin, source: "builtin", note: note) }
        guard let pair = cache(home, bot: bot).read() else { return fallback(nil) }
        let doc: RulesDocument
        do { doc = try RulesDocument.decode(bot: bot, pair.json) } catch { return verified(pair, trust) ? fallback("cache_invalid") : fallback("cache_bad_signature") }
        switch Trust.verify(data: pair.json, signatureBase64: pair.sig, keyId: doc.keyId, use: "rules", ctx: trust) {
        case .untrusted(let why): return fallback("cache_\(why)")
        case .trusted(let id):
            guard !doc.isExpired(at: trust.now) else { return fallback("cache_expired") }
            guard doc.revision >= builtin.revision else { return fallback("cache_older_than_builtin") }
            return LoadedRules(document: doc, source: "cache", keyId: id, note: nil)
        }
    }

    /// A document that cannot be decoded may still carry a readable key_id: used to tell "signed but unreadable"
    /// (`cache_invalid`) from "not trusted" (`cache_bad_signature`).
    private static func verified(_ pair: (json: Data, sig: String), _ trust: TrustContext) -> Bool {
        let id = RulesDocument.peekKeyId(pair.json)
        if case .trusted = Trust.verify(data: pair.json, signatureBase64: pair.sig, keyId: id, use: "rules", ctx: trust) { return true }
        return false
    }

    public static func writeCache(json: Data, signature: String, home: URL, bot: String) throws {
        try cache(home, bot: bot).write(json: json, signature: signature)
    }
}
