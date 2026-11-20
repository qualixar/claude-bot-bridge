import Foundation
import CryptoKit

/// The ROOT public key (Ed25519), the same key as plugin/release-signing-public.pem and keys/root-public.pem. The root signs
/// the keyset (keys/keyset.json) and nothing else; its private key stays offline on the maintainer's machine, never in GitHub.
public enum ReleaseKey {
    /// Raw 32-byte key; the PEM is a 12-byte SPKI header followed by these bytes.
    public static let publicKeyBase64 = "iBMcVC9bskstLcP7sdhHD+dWPJpqsneHQ74/hzIQQSM="
    public static var publicKey: Data { Data(base64Encoded: publicKeyBase64) ?? Data() }
}

public enum RulesVerifier {
    /// True only when `signatureBase64` (a detached Ed25519 signature over the exact bytes of `data`) verifies.
    public static func verify(data: Data, signatureBase64: String, publicKey: Data) -> Bool {
        let cleaned = signatureBase64.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let sig = Data(base64Encoded: cleaned), sig.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(sig, for: data)
    }
}
