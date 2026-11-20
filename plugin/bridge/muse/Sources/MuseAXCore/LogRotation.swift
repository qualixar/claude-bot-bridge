import Foundation

/// launchd appends the canary's output to a log forever. Keeps the newest `keepBytes` (from a line start) once the
/// file passes `maxBytes`. Rewrites in place, so a descriptor launchd holds open keeps working.
public enum LogRotation {
    public static let defaultMax = 2 * 1024 * 1024
    public static let defaultKeep = 1024 * 1024

    public static func trim(_ url: URL, maxBytes: Int = defaultMax, keepBytes: Int = defaultKeep) {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > maxBytes,
              let data = try? Data(contentsOf: url) else { return }
        var tail = data.suffix(keepBytes)
        if let nl = tail.firstIndex(of: 0x0A), nl < tail.endIndex { tail = tail.suffix(from: tail.index(after: nl)) }
        guard let h = try? FileHandle(forWritingTo: url) else { return }
        defer { try? h.close() }
        try? h.truncate(atOffset: 0)
        try? h.write(contentsOf: tail)
    }
}
