import Foundation

/// One muse-ax call at a time may drive the Muse window: two sends racing would type into each other's chat.
/// A cross-process lock file (`FileLock`: pid + nonce) at `<CBB_HOME>/.ui.lock`. A waiting caller polls for up to
/// `timeout` seconds, then fails with the retry-able `busy` error before it has typed or clicked anything.
public enum UILock {
    public static let defaultTimeout: TimeInterval = 10
    public static let retryAfterSeconds = 5

    public static func path(home: URL) -> URL { home.appendingPathComponent(".ui.lock") }

    public static func withLock<T>(home: URL, timeout: TimeInterval = defaultTimeout, pollInterval: TimeInterval = 0.1,
                                   _ body: () throws -> T) throws -> T {
        let deadline = Date().addingTimeInterval(timeout)
        var held = FileLock.acquire(at: path(home: home))
        while held == nil {
            guard Date() < deadline else { throw MuseError.busy }
            Thread.sleep(forTimeInterval: pollInterval)
            held = FileLock.acquire(at: path(home: home))
        }
        defer { held?.release() }
        return try body()
    }
}
