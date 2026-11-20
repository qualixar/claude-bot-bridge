import Foundation

/// The moments at which the helper itself posted synthetic click and key events during its most recent send or dry-run. The idle guard
/// uses them to tell those events from the user's own input: input counts as ours only when it lies within
/// `IdleGuard.ownEventTolerance` of one of these moments, not merely somewhere between the first and the last.
public struct PostedWindow: Equatable {
    /// The window never spans more than this: older posts are dropped (an input that long ago is not "just now" anyway).
    public static let maxSpan: TimeInterval = 30
    /// A very long message posts a lot of events; the newest this many are kept.
    public static let maxPosts = 4096

    /// Sorted, newest `maxSpan` seconds only, at most `maxPosts`.
    public let posts: [Date]
    public var start: Date { posts.first ?? .distantPast }
    public var end: Date { posts.last ?? .distantPast }

    public init(posts: [Date]) {
        let sorted = posts.sorted()
        let floor = (sorted.last ?? .distantPast).addingTimeInterval(-Self.maxSpan)
        self.posts = Array(sorted.filter { $0 >= floor }.suffix(Self.maxPosts))
    }

    /// A window known only by its first and last post (the format of older records).
    public init(start: Date, end: Date) { self.init(posts: start == end ? [start] : [start, end]) }
}

/// `<CBB_HOME>/last-post.json`: the posts of the most recent send, written by the helper after it types.
public enum PostedEvents {
    public static func path(home: URL) -> URL { home.appendingPathComponent("last-post.json") }

    public static func record(_ w: PostedWindow, home: URL) throws {
        let body: [String: Any] = ["start": w.start.timeIntervalSince1970, "end": w.end.timeIntervalSince1970,
                                   "posts": w.posts.map { $0.timeIntervalSince1970 }]
        try AtomicFile.write(try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), to: path(home: home))
    }

    /// nil when there is no record, it is damaged, or it is not a window (end before start, no usable post).
    public static func read(home: URL) -> PostedWindow? {
        guard let d = try? Data(contentsOf: path(home: home)),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let s = o["start"] as? Double, let e = o["end"] as? Double, s.isFinite, e.isFinite, e >= s else { return nil }
        guard let raw = o["posts"] as? [Double] else { return PostedWindow(start: Date(timeIntervalSince1970: s), end: Date(timeIntervalSince1970: e)) }
        let posts = raw.filter { $0.isFinite }.map { Date(timeIntervalSince1970: $0) }
        return posts.isEmpty ? nil : PostedWindow(posts: posts)
    }
}

/// Refuses to take over the keyboard and mouse while the user is using them. The live caller passes the smaller of
/// the seconds since the last keyboard and mouse event (CGEventSource, combined session state). That clock also sees
/// the helper's own events, so the newest input is ignored when it falls within `ownEventTolerance` of one of the moments at
/// which the helper itself posted an event (see `PostedWindow`); input in between, or outside the last 30 s of posting, is the user's.
public enum IdleGuard {
    public static let defaultSeconds: TimeInterval = 3
    static let maxSeconds: TimeInterval = 3600
    /// How far from one of our recorded posts an input event may lie and still count as ours (clock reading vs. our post).
    public static let ownEventTolerance: TimeInterval = 0.4

    /// CBB_IDLE_SECONDS: how long the user must have been idle. 0 turns the guard off; junk falls back to 3.
    public static func threshold(env: [String: String]) -> TimeInterval {
        guard let raw = env["CBB_IDLE_SECONDS"], let v = Double(raw), v.isFinite, v >= 0, v <= maxSeconds else { return defaultSeconds }
        return v
    }

    /// Seconds since the user's last input: `.infinity` when the newest input event is the helper's own.
    public static func userInputAge(secondsSinceInput: TimeInterval, now: Date, posted: PostedWindow?) -> TimeInterval {
        guard let w = posted, !w.posts.isEmpty, w.end <= now else { return secondsSinceInput }   // a record from the future is not trusted
        let inputAt = now.addingTimeInterval(-secondsSinceInput)
        let ours = w.posts.contains { abs(inputAt.timeIntervalSince($0)) <= ownEventTolerance }
        return ours ? .infinity : secondsSinceInput
    }

    public static func check(secondsSinceInput: TimeInterval, threshold: TimeInterval) throws {
        guard threshold > 0, secondsSinceInput < threshold else { return }
        throw MuseError.userActive(retryAfter: max(1, Int((threshold - secondsSinceInput).rounded(.up))))
    }

    public static func check(secondsSinceInput: TimeInterval, threshold: TimeInterval, now: Date, posted: PostedWindow?) throws {
        try check(secondsSinceInput: userInputAge(secondsSinceInput: secondsSinceInput, now: now, posted: posted), threshold: threshold)
    }
}
