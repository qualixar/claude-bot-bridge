import Foundation
import MuseAXCore

/// The root key every signature chain ends in, and the trust context built from it. Debug builds (used by the test
/// suite) may substitute a throwaway root key; release builds never read the override.
func activeRootKey() -> Data {
    #if DEBUG
    if let b = ProcessInfo.processInfo.environment["CBB_TEST_PUBKEY_B64"], let d = Data(base64Encoded: b) { return d }
    #endif
    return ReleaseKey.publicKey
}

enum LiveTrust {
    /// The root key, the best keyset on this machine (refreshed copy or the one compiled in) and the clock.
    static func context(home: URL = RulesStore.home(), now: Date = Date()) -> TrustContext {
        let root = activeRootKey()
        var bundled = BuiltinKeyset.bundled
        #if DEBUG
        // A throwaway root cannot vouch for the real compiled-in keyset; tests bring their own through CBB_KEYSET_URL.
        if ProcessInfo.processInfo.environment["CBB_TEST_PUBKEY_B64"] != nil { bundled = nil }
        #endif
        return TrustContext(rootKey: root, keyset: KeysetStore.load(home: home, rootKey: root, bundled: bundled, now: now), now: now)
    }

    static func bundledKeyset() -> (json: Data, signature: String)? {
        #if DEBUG
        if ProcessInfo.processInfo.environment["CBB_TEST_PUBKEY_B64"] != nil { return nil }
        #endif
        return BuiltinKeyset.bundled
    }
}
