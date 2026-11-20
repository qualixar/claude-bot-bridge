import Foundation
import CryptoKit

/// `<CBB_HOME>/sends.jsonl`: append-only record of every send attempt. It holds the time, the chat, a SHA-256 of the
/// text, its length and the outcome code, never the text itself.
public enum SendJournal {
    public struct Entry {
        public let chat: String, text: String, outcome: String
        public init(chat: String, text: String, outcome: String) { self.chat = chat; self.text = text; self.outcome = outcome }
    }

    public static func path(home: URL) -> URL { home.appendingPathComponent("sends.jsonl") }

    public static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func append(_ e: Entry, home: URL, now: Date = Date()) throws {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let record: [String: Any] = ["at": iso.string(from: now), "chat": e.chat, "sha256": sha256Hex(e.text),
                                     "length": e.text.unicodeScalars.count, "outcome": e.outcome]
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) + Data("\n".utf8)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let fd = open(path(home: home).path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        guard fd >= 0 else { throw MuseError.inputFailed("could not open the send journal: \(String(cString: strerror(errno)))") }
        defer { close(fd) }
        // One write() on an O_APPEND descriptor lands as a whole, so concurrent senders cannot interleave lines.
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, data.count) }
        guard written == data.count else { throw MuseError.inputFailed("could not write the send journal") }
    }

    /// The last `last` records (all when nil), oldest first. Missing or damaged lines are skipped.
    public static func read(home: URL, last: Int?) -> [[String: Any]] {
        guard let text = try? String(contentsOf: path(home: home), encoding: .utf8) else { return [] }
        let rows = text.split(separator: "\n").compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
        }
        return last.map { Array(rows.suffix($0)) } ?? rows
    }
}
