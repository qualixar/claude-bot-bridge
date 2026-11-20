import Foundation

/// A lock file that records its owner ("pid\nnonce\n"). It is released only by the process that holds the nonce, and
/// taken over only when the recorded process is gone AND the file is older than `staleAfter`: a live owner is never
/// evicted, and a lock whose owner just died is left alone for a while.
public final class FileLock {
    private let url: URL
    private let nonce: String

    private init(url: URL, nonce: String) { self.url = url; self.nonce = nonce }

    public static func processAlive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    public static func acquire(at url: URL, staleAfter: TimeInterval = 120, now: () -> Date = Date.init,
                               isAlive: (Int32) -> Bool = FileLock.processAlive) -> FileLock? {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let nonce = UUID().uuidString
        if create(url, nonce) { return FileLock(url: url, nonce: nonce) }
        guard isStale(url, staleAfter, now(), isAlive) else { return nil }
        // Only one taker wins the rename; the loser sees ENOENT and backs off.
        let aside = url.appendingPathExtension("stale-\(nonce)")
        guard rename(url.path, aside.path) == 0 else { return nil }
        try? FileManager.default.removeItem(at: aside)
        return create(url, nonce) ? FileLock(url: url, nonce: nonce) : nil
    }

    public func release() {
        guard let owner = FileLock.owner(url), owner.nonce == nonce else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private static func create(_ url: URL, _ nonce: String) -> Bool {
        let fd = open(url.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        let body = Array("\(getpid())\n\(nonce)\n".utf8)
        return write(fd, body, body.count) == body.count
    }

    private static func owner(_ url: URL) -> (pid: Int32, nonce: String)? {
        guard let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let parts = s.split(separator: "\n").map(String.init)
        guard parts.count == 2, let pid = Int32(parts[0]) else { return nil }
        return (pid, parts[1])
    }

    private static func isStale(_ url: URL, _ staleAfter: TimeInterval, _ now: Date, _ isAlive: (Int32) -> Bool) -> Bool {
        guard let m = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date,
              now.timeIntervalSince(m) > staleAfter else { return false }
        if let o = owner(url) { return !isAlive(o.pid) }
        return true
    }
}
