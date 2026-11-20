import Foundation

public enum ReplyWaiter {
    /// Waits for a new, finished assistant reply. `snapshot` reads the chat's messages (the caller opens the chat and
    /// holds the UI lock only for the duration of one snapshot, so a long wait never starves a send). The first
    /// snapshot sets the baseline and any error there is final; a later `busy` skips that poll; other errors stop the wait.
    public static func wait(timeout: TimeInterval, interval: TimeInterval, now: () -> Date, sleep: (TimeInterval) -> Void,
                            snapshot: () throws -> [Message]) throws -> Message {
        var watcher = ReplyWatcher(baseline: MessageParser.replyAfterLastUser(try snapshot()))
        let deadline = now().addingTimeInterval(timeout)
        while now() < deadline {
            do {
                if let reply = watcher.feed(try snapshot()) { return reply }
            } catch MuseError.busy { /* someone else is using Muse: try again next poll */ }
            sleep(interval)
        }
        throw MuseError.timeout("No new assistant message within \(Int(timeout)) s")
    }
}
