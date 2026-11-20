import Foundation

/// Splits anchor results into real failures and the one informational entry. Muse hides its chat list in a narrow
/// window (for example side by side with another app); that is not a broken UI, only a limit on listing chats,
/// and listing checks it itself.
public struct SelftestReport {
    public let failed: [String]
    public let checks: [String: Bool]
    /// nil when the list was not probed.
    public let chatListVisible: Bool?

    public init(_ results: [(String, Bool)]) {
        let info = SendAnchors.switchingOnly
        failed = results.filter { !$0.1 && !info.contains($0.0) }.map { $0.0 }
        var c: [String: Bool] = [:]
        for (k, v) in results where !info.contains(k) { c[k] = v }
        checks = c
        chatListVisible = results.first { $0.0 == "chat_list" }?.1
    }
}
