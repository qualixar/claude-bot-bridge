import Testing
import Foundation
import CryptoKit
@testable import MuseAXCore

/// Throwaway three-level hierarchy: a root, a rules key and a binary key, plus a signed keyset that lists the last two.
struct Hierarchy {
    let root = Keys.fresh(), rules = Keys.fresh(), binary = Keys.fresh()
    let now = Date(timeIntervalSince1970: 1_800_000_000)   // 2027-01-15

    func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }
    func years(_ n: Double) -> String { iso(now.addingTimeInterval(n * 365 * 86400)) }

    func keysetObject(issued: Date? = nil, notAfter: String? = nil, revoked: [String] = [], rulesNotAfter: String? = nil,
                      extra: [[String: Any]] = []) -> [String: Any] {
        ["schema": 1, "issued_at": iso(issued ?? now.addingTimeInterval(-86400)), "not_after": notAfter ?? years(1),
         "keys": [
            ["id": "rules-1", "use": "rules", "public_key_b64": rules.pub.base64EncodedString(), "not_after": rulesNotAfter ?? years(2)],
            ["id": "binary-1", "use": "binary", "public_key_b64": binary.pub.base64EncodedString(), "not_after": years(2)],
         ] + extra, "revoked": revoked]
    }
    func bytes(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) }
    func signed(_ o: [String: Any]? = nil) -> (json: Data, sig: String) {
        let j = bytes(o ?? keysetObject())
        return (j, Keys.sign(j, root.priv))
    }
    var keyset: Keyset { try! Keyset.decode(signed().json) }
    var ctx: TrustContext { TrustContext(rootKey: root.pub, keyset: .valid(keyset, source: "test"), now: now) }
}

@Suite struct KeysetDecodeTests {
    let h = Hierarchy()
    @Test func decodesAValidKeyset() throws {
        let k = try Keyset.decode(h.signed().json)
        #expect(k.schema == 1 && k.keys.map(\.id) == ["rules-1", "binary-1"] && k.keys.map(\.use) == ["rules", "binary"] && k.revoked.isEmpty)
        #expect(k.keys[0].publicKey == h.rules.pub)
    }
    @Test func rejectsABrokenShapeWithAReasonNotACrash() {
        func bad(_ f: (inout [String: Any]) -> Void) -> Data { var o = h.keysetObject(); f(&o); return h.bytes(o) }
        func keys(_ o: [String: Any]) -> [[String: Any]] { o["keys"] as! [[String: Any]] }
        #expect(throws: KeysetError.schemaUnsupported(2)) { try Keyset.decode(bad { $0["schema"] = 2; $0["keys"] = "other shape" }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(Data("nope".utf8)) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { $0["keys"] = [Any]() }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { $0["issued_at"] = "yesterday" }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { $0.removeValue(forKey: "not_after") }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { var k = keys($0); k[1]["id"] = "rules-1"; $0["keys"] = k }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { var k = keys($0); k[0]["use"] = "root"; $0["keys"] = k }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { var k = keys($0); k[0]["public_key_b64"] = "AAAA"; $0["keys"] = k }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { var k = keys($0); k[0]["id"] = "has space"; $0["keys"] = k }) }
        #expect(throws: KeysetError.self) { try Keyset.decode(bad { $0["revoked"] = [1, 2] }) }
    }
    @Test func unknownKeysAreIgnored() throws {
        var o = h.keysetObject(); o["note"] = "later"
        _ = try Keyset.decode(h.bytes(o))
    }
}

@Suite struct KeysetVerifyTests {
    let h = Hierarchy()
    func verify(_ s: (json: Data, sig: String), root: Data? = nil) -> KeysetState {
        KeysetVerifier.verify(json: s.json, signatureBase64: s.sig, rootKey: root ?? h.root.pub, now: h.now)
    }
    @Test func aKeysetSignedByTheRootIsValid() {
        guard case .valid(let k, _) = verify(h.signed()) else { Issue.record("expected valid"); return }
        #expect(k.keys.count == 2)
    }
    @Test func aKeysetSignedByAnyOtherKeyIsInvalid() {
        // The rules key must not be able to vouch for keys, only the root can.
        let j = h.bytes(h.keysetObject())
        guard case .invalid(let why) = verify((j, Keys.sign(j, h.rules.priv))) else { Issue.record("expected invalid"); return }
        #expect(why == "bad_signature")
        guard case .invalid = verify(h.signed(), root: Keys.fresh().pub) else { Issue.record("expected invalid"); return }
    }
    @Test func aTamperedKeysetIsInvalid() {
        let s = h.signed()
        guard case .invalid = verify((s.json + Data(" ".utf8), s.sig)) else { Issue.record("expected invalid"); return }
    }
    @Test func signedButMalformedIsInvalidWithItsReason() {
        let j = Data(#"{"schema":1}"#.utf8)
        guard case .invalid(let why) = verify((j, Keys.sign(j, h.root.priv))) else { Issue.record("expected invalid"); return }
        #expect(why.hasPrefix("keyset_invalid"))
    }
    @Test func anExpiredKeysetIsReportedAsExpiredNotValid() {
        let past = h.iso(h.now.addingTimeInterval(-3600))
        let s = h.signed(h.keysetObject(issued: h.now.addingTimeInterval(-86400 * 400), notAfter: past))
        guard case .expired = verify(s) else { Issue.record("expected expired"); return }
    }
}

@Suite struct KeysetLookupTests {
    let h = Hierarchy()
    func key(_ k: Keyset, _ id: String, _ use: String) -> Result<Data, KeyRejection> { k.key(id: id, use: use, now: h.now) }

    @Test func findsAKeyByIdAndUse() throws {
        #expect(try key(h.keyset, "rules-1", "rules").get() == h.rules.pub)
        #expect(try key(h.keyset, "binary-1", "binary").get() == h.binary.pub)
    }
    @Test func unknownIdAndWrongUseAreDifferentRejections() {
        #expect(key(h.keyset, "nope", "rules") == .failure(.unknown))
        #expect(key(h.keyset, "binary-1", "rules") == .failure(.wrongUse))
        #expect(key(h.keyset, "rules-1", "binary") == .failure(.wrongUse))
    }
    @Test func revokedByIdOrByPublicKey() throws {
        let byId = try Keyset.decode(h.bytes(h.keysetObject(revoked: ["rules-1"])))
        #expect(key(byId, "rules-1", "rules") == .failure(.revoked))
        #expect(try key(byId, "binary-1", "binary").get() == h.binary.pub)
        let byKey = try Keyset.decode(h.bytes(h.keysetObject(revoked: [h.rules.pub.base64EncodedString()])))
        #expect(key(byKey, "rules-1", "rules") == .failure(.revoked))
    }
    @Test func anExpiredKeyIsRejected() throws {
        let k = try Keyset.decode(h.bytes(h.keysetObject(rulesNotAfter: h.iso(h.now.addingTimeInterval(-1)))))
        #expect(key(k, "rules-1", "rules") == .failure(.expired))
    }
}
