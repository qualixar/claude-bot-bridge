import Foundation

/// Every failure the CLI can report. `code` is stable and machine-readable.
public enum MuseError: Error, Equatable {
    case notRunning
    case notTrusted
    case anchorMissing(String)
    case chatListHidden(width: Int?)
    case chatSwitchUnsupported(String)
    case chatNotFound(String)
    case sheetOpen
    case composerNotFound
    case invalidArgument(String)
    case refused(String)
    case timeout(String)
    case inputFailed(String)
    case composerMismatch(String)
    case clickTargetMismatch(String)
    case chatChanged(String)
    case chatAmbiguous(String)
    /// Another muse-ax call holds the Muse UI lock. Retry-able; nothing was typed or clicked.
    case busy
    /// The user touched the keyboard or mouse a moment ago. Retry-able; nothing was typed.
    case userActive(retryAfter: Int)
    case uiUnavailable(version: String?, failed: [String])

    public var code: String {
        switch self {
        case .notRunning: return "not_running"
        case .notTrusted: return "not_trusted"
        case .anchorMissing: return "anchor_missing"
        case .chatListHidden: return "chat_list_hidden"
        case .chatSwitchUnsupported: return "chat_switch_unsupported"
        case .chatNotFound: return "chat_not_found"
        case .sheetOpen: return "sheet_open"
        case .composerNotFound: return "composer_not_found"
        case .invalidArgument: return "invalid_argument"
        case .refused: return "refused"
        case .timeout: return "timeout"
        case .inputFailed: return "input_failed"
        case .composerMismatch: return "composer_mismatch"
        case .clickTargetMismatch: return "click_target_mismatch"
        case .chatChanged: return "chat_changed"
        case .chatAmbiguous: return "chat_ambiguous"
        case .busy: return "busy"
        case .userActive: return "user_active"
        case .uiUnavailable: return "ui_unavailable"
        }
    }

    public var message: String {
        switch self {
        case .notRunning: return "Muse is not running. Open the app first."
        case .notTrusted: return "Accessibility permission missing. Grant it to the calling terminal/app in System Settings > Privacy & Security > Accessibility."
        case .anchorMissing(let a): return "UI anchor not found: \(a). Meta may have changed the Muse UI; run `muse-ax selftest`."
        case .chatListHidden(let w):
            let size = w.map { " (the window is \($0) px wide)" } ?? ""
            return "Muse is hiding its chat list\(size), usually because the window is too narrow. Widen the Muse window (about 900 px works), then retry."
        case .chatSwitchUnsupported(let n): return "This bridge never presses Muse's chat list or its \"New side chat\" button, so it cannot switch to or create a chat. Only the chat that is already open can be used (requested: \"\(n)\"). Open it in Muse yourself, then retry."
        case .chatNotFound(let n): return "No chat named \"\(n)\". Run `muse-ax chats` to list names."
        case .sheetOpen: return "A sheet/dialog is open in Muse (probably the Attach-file panel). Refusing to type."
        case .composerNotFound: return "Composer frame not found. Open a chat first."
        case .invalidArgument(let m): return m
        case .refused(let m): return m
        case .timeout(let m): return m
        case .inputFailed(let m): return m
        case .composerMismatch(let m): return "Composer check failed, nothing was sent: \(m)"
        case .clickTargetMismatch(let m): return "Refusing to click, nothing was typed: \(m)"
        case .chatChanged(let m): return "The open chat changed, nothing was sent: \(m)"
        case .chatAmbiguous(let n): return "More than one sidebar button is named \"\(n)\", so the right chat cannot be told apart; nothing was typed. Rename one of the chats in Muse, or open the chat yourself."
        case .busy: return "Another muse-ax call is using the Muse window right now; nothing was typed. Retry in a few seconds."
        case .userActive: return "You were using the keyboard or mouse a moment ago, so muse-ax did not take over; nothing was typed. Retry when you are idle."
        case .uiUnavailable(let v, let failed):
            let ver = v.map { "Muse \($0)" } ?? "This Muse (version unknown)"
            return "\(ver) has no matching UI rules and the live probe failed (missing anchors: \(failed.joined(separator: ", "))). Do not retry sending through the UI: hand the task over through the board instead, and run `muse-ax rules update`."
        }
    }

    /// Extra machine-readable fields for the JSON error object, when the error carries any.
    public var details: [String: Any]? {
        switch self {
        case .uiUnavailable(let v, let failed): return ["muse_version": v as Any? ?? NSNull(), "failed_anchors": failed]
        case .busy: return ["retry_after_seconds": UILock.retryAfterSeconds]
        case .userActive(let s): return ["retry_after_seconds": s]
        default: return nil
        }
    }
}
