import Foundation

/// The key hierarchy. The binary and the MCP server embed ONE public key, the root. The root signs a keyset
/// (keys/keyset.json) that lists short-lived signing keys by id and purpose: `rules` keys sign rules documents,
/// `binary` keys sign binary manifests. A key can be retired (`not_after`) or revoked (`revoked`) by publishing a
/// newer keyset, without ever touching the root.
///
/// Rules of trust (the MCP server keeps the same ones, mcp/src/keyset.js):
///  - Every signed document names its key (`key_id`); a document without one is never accepted. The root signs keysets only.
///  - Only the newest verified keyset (by `issued_at`) counts; `KeysetStore` remembers it in `<CBB_HOME>/keys/current`, so a
///    failed download or a replayed older copy can never bring a revoked key back.
///  - When the newest keyset has expired, nothing is trusted ("keyset_expired"); an older keyset that has not lapsed yet never
///    takes over.

public enum KeysetError: Error, Equatable {
    case notJSON
    case schemaUnsupported(Int)
    case invalid(String)
}

public struct KeysetKey: Equatable {
    public let id: String
    public let use: String
    public let publicKey: Data
    public let notAfter: Date
    public var publicKeyBase64: String { publicKey.base64EncodedString() }
}

/// Why a named key was refused.
public enum KeyRejection: Error, Equatable {
    case unknown, wrongUse, revoked, expired
    public var code: String {
        switch self {
        case .unknown: return "key_unknown"
        case .wrongUse: return "key_wrong_use"
        case .revoked: return "key_revoked"
        case .expired: return "key_expired"
        }
    }
}

public struct Keyset: Equatable {
    public static let supportedSchema = 1
    public static let uses: Set<String> = ["rules", "binary"]
    public let schema: Int
    public let issuedAt: Date
    public let notAfter: Date
    public let keys: [KeysetKey]
    /// Key ids or base64 public keys that must no longer be trusted, even before their `not_after`.
    public let revoked: [String]

    /// The public key `id` may sign `use` documents with: it must exist, have that purpose, not be revoked and not be expired.
    public func key(id: String, use: String, now: Date) -> Result<Data, KeyRejection> {
        guard let k = keys.first(where: { $0.id == id }) else { return .failure(.unknown) }
        guard k.use == use else { return .failure(.wrongUse) }
        guard !revoked.contains(k.id), !revoked.contains(k.publicKeyBase64) else { return .failure(.revoked) }
        guard now <= k.notAfter else { return .failure(.expired) }
        return .success(k.publicKey)
    }
}

extension Keyset {
    /// Decodes and validates. A newer schema is reported before any shape is assumed; unknown keys are ignored.
    public static func decode(_ data: Data) throws -> Keyset {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw KeysetError.notJSON }
        guard let schema = o["schema"] as? Int else { throw KeysetError.invalid("missing or unreadable \"schema\"") }
        guard schema == supportedSchema else { throw KeysetError.schemaUnsupported(schema) }
        let issued = try date(o["issued_at"], "issued_at"), notAfter = try date(o["not_after"], "not_after")
        guard let rawKeys = o["keys"] as? [[String: Any]], !rawKeys.isEmpty else { throw KeysetError.invalid("keys must be a non-empty list") }
        let keys = try rawKeys.map(key)
        guard Set(keys.map(\.id)).count == keys.count else { throw KeysetError.invalid("duplicate key id") }
        guard let revoked = (o["revoked"] ?? [String]()) as? [String] else { throw KeysetError.invalid("revoked must be a list of strings") }
        return Keyset(schema: schema, issuedAt: issued, notAfter: notAfter, keys: keys, revoked: revoked)
    }

    private static func key(_ k: [String: Any]) throws -> KeysetKey {
        guard let id = k["id"] as? String, id.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil else {
            throw KeysetError.invalid("a key id must be 1-64 characters of letters, digits, . _ -")
        }
        guard let use = k["use"] as? String, uses.contains(use) else { throw KeysetError.invalid("key \(id): use must be rules or binary") }
        guard let b64 = k["public_key_b64"] as? String, let pub = Data(base64Encoded: b64), pub.count == 32 else {
            throw KeysetError.invalid("key \(id): public_key_b64 must be a base64 Ed25519 public key (32 bytes)")
        }
        return KeysetKey(id: id, use: use, publicKey: pub, notAfter: try date(k["not_after"], "key \(id) not_after"))
    }

    static func date(_ v: Any?, _ what: String) throws -> Date {
        guard let s = v as? String, let d = ISO8601DateFormatter().date(from: s) else {
            throw KeysetError.invalid("\(what) must be an ISO 8601 UTC time such as 2027-11-20T00:00:00Z")
        }
        return d
    }
}

/// What this machine knows about the keyset right now.
public enum KeysetState: Equatable {
    /// No keyset has shipped (none bundled, none cached): no key is trusted.
    case absent
    /// A keyset exists but failed a check. Fail closed: no key is trusted.
    case invalid(String)
    /// Signed by the root, but past its own `not_after`. When this is the NEWEST keyset, nothing is trusted: fail closed.
    case expired(Keyset)
    case valid(Keyset, source: String)

    public var name: String {
        switch self {
        case .absent: return "absent"
        case .invalid: return "invalid"
        case .expired: return "expired"
        case .valid: return "valid"
        }
    }
}

public enum KeysetVerifier {
    /// Checks the detached root signature over the exact bytes, then the shape, then the keyset's own expiry.
    public static func verify(json: Data, signatureBase64: String, rootKey: Data, now: Date) -> KeysetState {
        guard RulesVerifier.verify(data: json, signatureBase64: signatureBase64, publicKey: rootKey) else { return .invalid("bad_signature") }
        let keyset: Keyset
        do { keyset = try Keyset.decode(json) } catch KeysetError.schemaUnsupported(let n) {
            return .invalid("keyset_schema_unsupported_\(n)")
        } catch { return .invalid("keyset_invalid: \(error)") }
        return now > keyset.notAfter ? .expired(keyset) : .valid(keyset, source: "")
    }
}

public enum SignatureCheck: Equatable {
    /// `keyId` is the keyset key that verified.
    case trusted(keyId: String)
    /// key_id_required, keyset_expired, keyset_unavailable, key_unknown, key_wrong_use, key_revoked, key_expired or bad_signature.
    case untrusted(String)
}

/// Everything signature checking needs: the root key, the keyset state and the clock.
public struct TrustContext {
    public let rootKey: Data
    public let keyset: KeysetState
    public let now: Date
    public init(rootKey: Data, keyset: KeysetState, now: Date = Date()) { self.rootKey = rootKey; self.keyset = keyset; self.now = now }
}

public enum Trust {
    /// A document is verified with the keyset key it names (`key_id`), for the purpose it is used for. No `key_id`, no trust:
    /// the root never signs rules or manifests, so there is no fallback to it.
    public static func verify(data: Data, signatureBase64: String, keyId: String?, use: String, ctx: TrustContext) -> SignatureCheck {
        guard let id = keyId, !id.isEmpty else { return .untrusted("key_id_required") }
        if case .expired = ctx.keyset { return .untrusted("keyset_expired") }
        guard case .valid(let keyset, _) = ctx.keyset else { return .untrusted("keyset_unavailable") }
        switch keyset.key(id: id, use: use, now: ctx.now) {
        case .failure(let why): return .untrusted(why.code)
        case .success(let pub):
            return RulesVerifier.verify(data: data, signatureBase64: signatureBase64, publicKey: pub)
                ? .trusted(keyId: id) : .untrusted("bad_signature")
        }
    }
}
