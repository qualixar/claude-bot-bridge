import Foundation

public enum SendRules {
    public static let prefix = "[Claude Code]"
    public static let maxLength = 500

    /// Bidirectional controls: they can make text read differently from what is typed.
    static let bidiControls: Set<UInt32> = [0x200E, 0x200F, 0x061C, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]

    /// Throws `.refused` unless the text may be sent. Returns the text unchanged.
    /// Every length below counts Unicode scalars, the same unit as mcp/src/validate.js.
    @discardableResult
    public static func validate(_ text: String) throws -> String {
        let scalars = text.unicodeScalars
        guard scalars.starts(with: prefix.unicodeScalars) else {
            throw MuseError.refused("Message must start with \"\(prefix)\".")
        }
        guard scalars.count <= maxLength else {
            throw MuseError.refused("Message is \(scalars.count) characters; the maximum is \(maxLength).")
        }
        if scalars.contains(where: isForbidden) {
            throw MuseError.refused("Message must be a single line without control or direction-changing characters.")
        }
        guard scalars.dropFirst(prefix.unicodeScalars.count).contains(where: isVisible) else {
            throw MuseError.refused("Message has no visible content after the prefix.")
        }
        return text
    }

    /// Cc (incl. U+0085), Zl, Zp and bidi controls.
    static func isForbidden(_ s: Unicode.Scalar) -> Bool {
        switch s.properties.generalCategory {
        case .control, .lineSeparator, .paragraphSeparator: return true
        default: return bidiControls.contains(s.value)
        }
    }

    /// Anything that is not whitespace, a space separator or an invisible format character (zero-width, soft hyphen...).
    static func isVisible(_ s: Unicode.Scalar) -> Bool {
        if s.properties.isWhitespace { return false }
        switch s.properties.generalCategory {
        case .format, .spaceSeparator: return false
        default: return true
        }
    }

    /// Pre-send gate over observed UI state.
    public static func preflight(running: Bool, sheetOpen: Bool, composerFound: Bool) throws {
        if !running { throw MuseError.notRunning }
        if sheetOpen { throw MuseError.sheetOpen }
        if !composerFound { throw MuseError.composerNotFound }
    }
}
