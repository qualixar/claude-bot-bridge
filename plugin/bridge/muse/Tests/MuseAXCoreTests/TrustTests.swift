import Testing
import Foundation
import CryptoKit
@testable import MuseAXCore

@Suite struct TrustTests {
    let h = Hierarchy()
    let data = Data(#"{"doc":"rules"}"#.utf8)
    func verify(_ sig: String, id: String? = "rules-1", use: String = "rules", ctx: TrustContext? = nil) -> SignatureCheck {
        Trust.verify(data: data, signatureBase64: sig, keyId: id, use: use, ctx: ctx ?? h.ctx)
    }

    @Test func aRulesKeyNamedInTheKeysetSignsRules() {
        #expect(verify(Keys.sign(data, h.rules.priv)) == .trusted(keyId: "rules-1"))
    }
    @Test func theBinaryKeyCannotSignRulesAndTheRulesKeyCannotSignBinaries() {
        #expect(verify(Keys.sign(data, h.binary.priv), id: "binary-1") == .untrusted("key_wrong_use"))
        #expect(verify(Keys.sign(data, h.rules.priv), id: "rules-1", use: "binary") == .untrusted("key_wrong_use"))
    }
    @Test func theNamedKeyMustBeTheOneThatSigned() {
        #expect(verify(Keys.sign(data, h.binary.priv), id: "rules-1") == .untrusted("bad_signature"))
        #expect(verify(Keys.sign(data, Keys.fresh().priv)) == .untrusted("bad_signature"))
    }
    @Test func theRootItselfNeverSignsRulesOnceAKeysetExists() {
        // Naming a key does not let the root sign in its place...
        #expect(verify(Keys.sign(data, h.root.priv)) == .untrusted("bad_signature"))
        // ...and no key_id at all is refused when a keyset is known.
        #expect(verify(Keys.sign(data, h.root.priv), id: nil) == .untrusted("key_id_required"))
    }
    @Test func revokedExpiredAndUnknownKeysAreRefused() throws {
        let revoked = TrustContext(rootKey: h.root.pub, keyset: .valid(try Keyset.decode(h.bytes(h.keysetObject(revoked: ["rules-1"]))), source: "t"), now: h.now)
        #expect(verify(Keys.sign(data, h.rules.priv), ctx: revoked) == .untrusted("key_revoked"))
        let expired = TrustContext(rootKey: h.root.pub, keyset: .valid(try Keyset.decode(h.bytes(h.keysetObject(rulesNotAfter: h.iso(h.now.addingTimeInterval(-5))))), source: "t"), now: h.now)
        #expect(verify(Keys.sign(data, h.rules.priv), ctx: expired) == .untrusted("key_expired"))
        #expect(verify(Keys.sign(data, h.rules.priv), id: "rules-9") == .untrusted("key_unknown"))
    }
    @Test func aKeyIdWithoutAnyUsableKeysetIsRefused() {
        for state in [KeysetState.absent, .invalid("bad_signature")] {
            let ctx = TrustContext(rootKey: h.root.pub, keyset: state, now: h.now)
            #expect(verify(Keys.sign(data, h.rules.priv), ctx: ctx) == .untrusted("keyset_unavailable"))
        }
    }
    // An expired keyset is the newest one the machine knows (see KeysetStore.load): nothing is trusted, and the reason says so.
    @Test func anExpiredKeysetTrustsNothingAndSaysSo() {
        let ctx = TrustContext(rootKey: h.root.pub, keyset: .expired(h.keyset), now: h.now)
        #expect(verify(Keys.sign(data, h.rules.priv), ctx: ctx) == .untrusted("keyset_expired"))
        #expect(verify(Keys.sign(data, h.binary.priv), id: "binary-1", use: "binary", ctx: ctx) == .untrusted("keyset_expired"))
    }

    // There is no root-signed compatibility path: a document without a key_id is refused whatever the keyset state.
    @Test func aDocumentWithoutAKeyIdIsNeverAccepted() {
        let states: [KeysetState] = [.absent, .invalid("bad_signature"), .expired(h.keyset), .valid(h.keyset, source: "bundled")]
        for state in states {
            let ctx = TrustContext(rootKey: h.root.pub, keyset: state, now: h.now)
            #expect(verify(Keys.sign(data, h.root.priv), id: nil, ctx: ctx) == .untrusted("key_id_required"))
            #expect(verify(Keys.sign(data, h.rules.priv), id: nil, ctx: ctx) == .untrusted("key_id_required"))
            #expect(verify(Keys.sign(data, h.rules.priv), id: "", ctx: ctx) == .untrusted("key_id_required"))
        }
    }
    @Test func garbageSignaturesAreUntrustedNotCrashes() {
        #expect(verify("") == .untrusted("bad_signature"))
        #expect(verify("%%%") == .untrusted("bad_signature"))
    }
}
