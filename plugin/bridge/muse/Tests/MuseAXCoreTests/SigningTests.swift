import Testing
import Foundation
import CryptoKit
@testable import MuseAXCore

enum Keys {
    typealias Pair = (priv: Curve25519.Signing.PrivateKey, pub: Data)
    static func fresh() -> Pair {
        let k = Curve25519.Signing.PrivateKey()
        return (k, k.publicKey.rawRepresentation)
    }
    static func sign(_ data: Data, _ k: Curve25519.Signing.PrivateKey) -> String {
        try! k.signature(for: data).base64EncodedString()
    }
}

@Suite struct SigningTests {
    @Test func validSignatureVerifies() {
        let k = Keys.fresh(); let data = Data("rules".utf8)
        #expect(RulesVerifier.verify(data: data, signatureBase64: Keys.sign(data, k.priv), publicKey: k.pub))
    }
    @Test func trailingNewlineInSignatureFileIsTolerated() {
        let k = Keys.fresh(); let data = Data("rules".utf8)
        #expect(RulesVerifier.verify(data: data, signatureBase64: Keys.sign(data, k.priv) + "\n", publicKey: k.pub))
    }
    @Test func tamperedDataTruncatedDataWrongKeyAndGarbageAllFail() {
        let k = Keys.fresh(); let other = Keys.fresh(); let data = Data("rules v1".utf8)
        let sig = Keys.sign(data, k.priv)
        #expect(!RulesVerifier.verify(data: Data("rules v2".utf8), signatureBase64: sig, publicKey: k.pub))
        #expect(!RulesVerifier.verify(data: data.prefix(4), signatureBase64: sig, publicKey: k.pub))
        #expect(!RulesVerifier.verify(data: data, signatureBase64: sig, publicKey: other.pub))
        #expect(!RulesVerifier.verify(data: data, signatureBase64: "not base64 !!", publicKey: k.pub))
        #expect(!RulesVerifier.verify(data: data, signatureBase64: "", publicKey: k.pub))
        #expect(!RulesVerifier.verify(data: data, signatureBase64: sig, publicKey: Data([1, 2, 3])))
    }
    @Test func embeddedReleaseKeyIsThePublishedOne() throws {
        #expect(ReleaseKey.publicKey.count == 32)
        let pem = Fx.repoFile("plugin/release-signing-public.pem")
        guard FileManager.default.fileExists(atPath: pem.path) else { return }
        let b64 = try String(contentsOf: pem, encoding: .utf8).split(separator: "\n").filter { !$0.hasPrefix("-----") }.joined()
        let der = Data(base64Encoded: b64)!
        #expect(der.count == 44)
        #expect(der.suffix(32) == ReleaseKey.publicKey)
    }
}
