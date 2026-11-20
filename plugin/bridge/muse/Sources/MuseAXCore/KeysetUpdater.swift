import Foundation

public struct KeysetUpdateOutcome: Equatable {
    public let updated: Bool
    /// updated | unchanged | not_newer | network_error | bad_signature | invalid_keyset | expired | bad_url | cache_write_failed | skipped
    public let reason: String
    public let detail: String?

    public init(updated: Bool, reason: String, detail: String? = nil) { self.updated = updated; self.reason = reason; self.detail = detail }

    public var fields: [String: Any] {
        var f: [String: Any] = ["updated": updated, "reason": reason]
        if let d = detail { f["detail"] = d }
        return f
    }
}

/// `muse-ax rules update` refreshes the keyset first (same transport and rules as the rules themselves): fetch it,
/// check the root's signature, and only then replace the cached copy. A keyset is installed only when it is newer
/// (`issued_at`) than everything already known, so an old validly-signed copy cannot undo a revocation.
public enum KeysetUpdater {
    public static let defaultURL = "https://raw.githubusercontent.com/qualixar/claude-bot-bridge/main/keys/keyset.json"
    public static let maxBytes = 64 * 1024

    /// CBB_KEYSET_URL, else the default. nil (skip) when CBB_RULES_URL points the rules somewhere else and no keyset
    /// URL was given, so a test server or a mirror never causes calls to the real GitHub.
    public static func url(env: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        if let raw = env["CBB_KEYSET_URL"], !raw.isEmpty, let u = URL(string: raw) { return u }
        if let r = env["CBB_RULES_URL"], !r.isEmpty { return nil }
        return URL(string: defaultURL)
    }

    public static func update(url: URL, home: URL, rootKey: Data, bundled: (json: Data, signature: String)?,
                              fetch: Fetcher, now: Date = Date()) -> KeysetUpdateOutcome {
        guard RulesUpdater.isAllowed(url), let sigURL = URL(string: url.absoluteString + ".sig") else {
            return .init(updated: false, reason: "bad_url", detail: "unsupported URL scheme or host")
        }
        let json: Data, sig: String
        switch fetch(url) {
        case .failure(let e):
            return e.tooLarge ? .init(updated: false, reason: "invalid_keyset", detail: "file larger than \(maxBytes) bytes") : .init(updated: false, reason: "network_error", detail: e.message)
        case .success(let d): json = d
        }
        guard json.count <= maxBytes else { return .init(updated: false, reason: "invalid_keyset", detail: "file larger than \(maxBytes) bytes") }
        switch fetch(sigURL) {
        case .failure(let e): return .init(updated: false, reason: "network_error", detail: e.message)
        case .success(let d): sig = String(decoding: d.prefix(1024), as: UTF8.self)
        }
        switch KeysetVerifier.verify(json: json, signatureBase64: sig, rootKey: rootKey, now: now) {
        case .invalid(let why):
            return .init(updated: false, reason: why == "bad_signature" ? "bad_signature" : "invalid_keyset", detail: why)
        case .expired: return .init(updated: false, reason: "expired", detail: "the keyset is past its not_after")
        case .absent: return .init(updated: false, reason: "invalid_keyset")
        case .valid(let incoming, _):
            return install(incoming, json: json, sig: sig, home: home, rootKey: rootKey, bundled: bundled, now: now)
        }
    }

    private static func install(_ incoming: Keyset, json: Data, sig: String, home: URL, rootKey: Data,
                                bundled: (json: Data, signature: String)?, now: Date) -> KeysetUpdateOutcome {
        if let cached = try? Data(contentsOf: KeysetStore.cachePaths(home: home).json), cached == json {
            return .init(updated: false, reason: "unchanged")
        }
        // The newest keyset already known, valid or expired, is the floor: an older one is never installed.
        let have: Keyset?
        switch KeysetStore.load(home: home, rootKey: rootKey, bundled: bundled, now: now) {
        case .valid(let k, _), .expired(let k): have = k
        default: have = nil
        }
        if let have = have, incoming.issuedAt <= have.issuedAt {
            return .init(updated: false, reason: "not_newer", detail: "a keyset issued at or after this one is already known")
        }
        do { try KeysetStore.writeCache(json: json, signature: sig, home: home) } catch {
            return .init(updated: false, reason: "cache_write_failed", detail: "\(error)")
        }
        return .init(updated: true, reason: "updated")
    }
}
