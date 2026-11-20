import Foundation

/// Splits text into UTF-16 chunks for CGEvent.keyboardSetUnicodeString (the system accepts about 20 units per event).
public enum TextChunker {
    public static let maxUnits = 20

    /// Chunks of at most `maxUnits` UTF-16 units, cut only between grapheme clusters. A single cluster longer than the
    /// limit (a pathological stack of combining marks) is cut between Unicode scalars, never inside a surrogate pair.
    public static func chunks(_ text: String, maxUnits: Int = TextChunker.maxUnits) -> [[UInt16]] {
        var out: [[UInt16]] = []
        var cur: [UInt16] = []
        func flush() { if !cur.isEmpty { out.append(cur); cur = [] } }
        for ch in text {
            let units = Array(ch.utf16)
            if units.count > maxUnits {
                flush()
                out.append(contentsOf: splitOnScalars(ch, maxUnits))
                continue
            }
            if cur.count + units.count > maxUnits { flush() }
            cur.append(contentsOf: units)
        }
        flush()
        return out
    }

    private static func splitOnScalars(_ ch: Character, _ maxUnits: Int) -> [[UInt16]] {
        var out: [[UInt16]] = []
        var cur: [UInt16] = []
        for s in ch.unicodeScalars {
            let u = Array(String(s).utf16)
            if cur.count + u.count > maxUnits { out.append(cur); cur = [] }
            cur.append(contentsOf: u)
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }
}
