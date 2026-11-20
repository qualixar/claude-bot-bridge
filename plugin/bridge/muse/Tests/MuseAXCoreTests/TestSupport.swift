import Foundation
@testable import MuseAXCore

/// Shared fixtures. Real profile data comes from the built-in rules (copied from rules/muse.json).
enum Fx {
    static let p12: Profile = BuiltinRules.document.profiles.first { $0.id == "muse-12.1" }!
    static let p13: Profile = BuiltinRules.document.profiles.first { $0.id == "muse-13.1" }!

    static func tempDir(_ name: String = "cbb") -> URL {
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }

    /// Repo root: .../plugin/bridge/muse/Tests/MuseAXCoreTests/<file> -> 5 levels up.
    static func repoFile(_ rel: String, file: String = #filePath) -> URL {
        var u = URL(fileURLWithPath: file)
        for _ in 0..<6 { u.deleteLastPathComponent() }
        return u.appendingPathComponent(rel)
    }

    /// A rules document with the given revision, based on the built-in profiles, naming the key `rules-1` like the real rules do.
    static func doc(revision: Int, schema: Int = 1) -> RulesDocument {
        RulesDocument(schema: schema, bot: "muse", revision: revision, profiles: BuiltinRules.document.profiles, keyId: "rules-1")
    }

    static func json(_ d: RulesDocument) -> Data {
        let e = JSONEncoder(); e.outputFormatting = [.sortedKeys]
        return try! e.encode(d)
    }
}

extension TrustContext {
    /// A trust context whose valid keyset lists `k` as the rules key `rules-1` (and nothing else), for tests that sign rules with
    /// one throwaway key. Rules documents must name `rules-1` (see `Fx.doc`): there is no root-signed fallback.
    static func rules(_ k: Keys.Pair, now: Date = Date()) -> TrustContext {
        let iso = ISO8601DateFormatter()
        let object: [String: Any] = [
            "schema": 1, "issued_at": iso.string(from: now.addingTimeInterval(-86400)), "not_after": iso.string(from: now.addingTimeInterval(86400 * 365)),
            "keys": [["id": "rules-1", "use": "rules", "public_key_b64": k.pub.base64EncodedString(), "not_after": iso.string(from: now.addingTimeInterval(86400 * 730))]],
            "revoked": [String](),
        ]
        let keyset = try! Keyset.decode(try! JSONSerialization.data(withJSONObject: object))
        return TrustContext(rootKey: Data(), keyset: .valid(keyset, source: "test"), now: now)
    }
}
