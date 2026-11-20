import Testing
import Foundation
@testable import MuseAXCore

/// The idle guard must not count the helper's own synthetic click and key events: a second send right after the
/// previous send or dry-run used to fail with `user_active` because of them.
@Suite struct OwnEventsIdleGuardTests {
    let now = Date(timeIntervalSince1970: 1_000_000)
    /// The previous send posted events from 6 s ago to 1 s ago.
    func window(endedAgo: TimeInterval = 1, lasted: TimeInterval = 5) -> PostedWindow {
        PostedWindow(start: now.addingTimeInterval(-(endedAgo + lasted)), end: now.addingTimeInterval(-endedAgo))
    }

    @Test func inputThatIsOurOwnLastEventDoesNotCount() throws {
        // The system reports "1 s since last input", and that input is exactly our last posted event.
        try IdleGuard.check(secondsSinceInput: 1, threshold: 3, now: now, posted: window())
    }
    @Test func ourOwnClickEarlierInTheWindowDoesNotCountEither() throws {
        // Key events posted to a pid are not input events, so the newest input can be our click, 5.5 s ago: a recorded post.
        let w = PostedWindow(posts: [now.addingTimeInterval(-6), now.addingTimeInterval(-5.5), now.addingTimeInterval(-1)])
        try IdleGuard.check(secondsSinceInput: 5.5, threshold: 8, now: now, posted: w)
    }
    @Test func inputDuringTheWindowButOutsideEveryRecordedPostCounts() {
        // We posted at -6 s, -5 s (a click) and -1 s. A keystroke at -3 s lies inside the window but 2 s from any of our posts.
        let w = PostedWindow(posts: [now.addingTimeInterval(-6), now.addingTimeInterval(-5), now.addingTimeInterval(-1)])
        #expect(throws: MuseError.self) { try IdleGuard.check(secondsSinceInput: 3, threshold: 8, now: now, posted: w) }
        #expect(IdleGuard.userInputAge(secondsSinceInput: 3, now: now, posted: w) == 3)
        // ...while input right at one of the posts is still ours, on both sides of it.
        #expect(IdleGuard.userInputAge(secondsSinceInput: 5.3, now: now, posted: w) == .infinity)
        #expect(IdleGuard.userInputAge(secondsSinceInput: 4.7, now: now, posted: w) == .infinity)
    }
    @Test func theToleranceIsPerPostNotPerWindow() {
        let w = PostedWindow(posts: [now.addingTimeInterval(-10), now.addingTimeInterval(-2)])
        let tol = IdleGuard.ownEventTolerance
        #expect(IdleGuard.userInputAge(secondsSinceInput: 10 - tol + 0.01, now: now, posted: w) == .infinity)
        #expect(IdleGuard.userInputAge(secondsSinceInput: 10 - tol - 0.05, now: now, posted: w) == 10 - tol - 0.05)
        #expect(IdleGuard.userInputAge(secondsSinceInput: 6, now: now, posted: w) == 6)   // the middle of a 8 s gap
    }
    @Test func aRealKeystrokeAfterOurLastEventStillCounts() {
        // Our last event was 1 s ago; the user typed 0.3 s ago, well after it.
        #expect(throws: MuseError.self) { try IdleGuard.check(secondsSinceInput: 0.3, threshold: 3, now: now, posted: window()) }
    }
    @Test func aRealKeystrokeBeforeOurWindowStillCounts() {
        // Input 20 s ago is not inside [start, end]; with a 30 s threshold it is real recent activity.
        #expect(throws: MuseError.self) { try IdleGuard.check(secondsSinceInput: 20, threshold: 30, now: now, posted: window()) }
    }
    @Test func withoutARecordNothingIsIgnored() {
        #expect(throws: MuseError.self) { try IdleGuard.check(secondsSinceInput: 1, threshold: 3, now: now, posted: nil) }
    }
    @Test func toleranceCoversTheGapBetweenOurLastPostAndTheClockReading() throws {
        let tol = IdleGuard.ownEventTolerance
        try IdleGuard.check(secondsSinceInput: 1 - tol + 0.01, threshold: 3, now: now, posted: window())
        #expect(throws: MuseError.self) { try IdleGuard.check(secondsSinceInput: 1 - tol - 0.05, threshold: 3, now: now, posted: window()) }
    }
    @Test func aRecordFromTheFutureIsNotTrusted() {
        let future = PostedWindow(start: now.addingTimeInterval(10), end: now.addingTimeInterval(15))
        #expect(throws: MuseError.self) { try IdleGuard.check(secondsSinceInput: 1, threshold: 3, now: now, posted: future) }
    }
    @Test func thresholdZeroStillTurnsTheGuardOff() throws {
        try IdleGuard.check(secondsSinceInput: 0, threshold: 0, now: now, posted: nil)
    }
    @Test func theOwnEventWindowIsCappedAt30Seconds() {
        // A send that (somehow) posted for 45 s: only the last 30 s of it count as ours.
        let w = PostedWindow(posts: [now.addingTimeInterval(-46), now.addingTimeInterval(-32), now.addingTimeInterval(-20), now.addingTimeInterval(-1)])
        #expect(PostedWindow.maxSpan == 30)
        #expect(w.posts.count == 2 && w.start == now.addingTimeInterval(-20) && w.end == now.addingTimeInterval(-1))
        #expect(IdleGuard.userInputAge(secondsSinceInput: 46, now: now, posted: w) == 46, "an input at the very start of a 45 s window is not ours")
        #expect(IdleGuard.userInputAge(secondsSinceInput: 20, now: now, posted: w) == .infinity)
    }
    @Test func theNumberOfRecordedPostsIsBoundedKeepingTheNewest() {
        let many = (0..<(PostedWindow.maxPosts + 50)).map { now.addingTimeInterval(-20 + Double($0) * 0.001) }
        let w = PostedWindow(posts: many)
        #expect(w.posts.count == PostedWindow.maxPosts && w.posts.last == many.last)
    }
    @Test func ageIsInfiniteWhenMaskedAndUnchangedOtherwise() {
        #expect(IdleGuard.userInputAge(secondsSinceInput: 1, now: now, posted: window()) == .infinity)
        #expect(IdleGuard.userInputAge(secondsSinceInput: 0.2, now: now, posted: window()) == 0.2)
        #expect(IdleGuard.userInputAge(secondsSinceInput: 2, now: now, posted: nil) == 2)
    }
}

@Suite struct PostedEventsStoreTests {
    @Test func recordsAndReadsTheLastWindowUnderTheBridgeHome() throws {
        let home = Fx.tempDir()
        let w = PostedWindow(start: Date(timeIntervalSince1970: 1_700_000_000.25), end: Date(timeIntervalSince1970: 1_700_000_004.5))
        try PostedEvents.record(w, home: home)
        #expect(PostedEvents.path(home: home).deletingLastPathComponent().standardizedFileURL == home.standardizedFileURL)
        #expect(PostedEvents.read(home: home) == w)
    }
    @Test func theNewestRecordReplacesTheOlder() throws {
        let home = Fx.tempDir()
        try PostedEvents.record(PostedWindow(start: Date(timeIntervalSince1970: 10), end: Date(timeIntervalSince1970: 12)), home: home)
        let newer = PostedWindow(start: Date(timeIntervalSince1970: 20), end: Date(timeIntervalSince1970: 23))
        try PostedEvents.record(newer, home: home)
        #expect(PostedEvents.read(home: home) == newer)
    }
    @Test func everyRecordedPostSurvivesTheRoundTrip() throws {
        let home = Fx.tempDir()
        let w = PostedWindow(posts: [10.25, 10.5, 12.0, 13.75].map { Date(timeIntervalSince1970: 1_700_000_000 + $0) })
        try PostedEvents.record(w, home: home)
        let back = try #require(PostedEvents.read(home: home))
        #expect(back.posts == w.posts && back.start == w.start && back.end == w.end)
    }
    @Test func anOlderRecordWithOnlyAStartAndAnEndStillReads() throws {
        let home = Fx.tempDir()
        try Data(#"{"start": 100, "end": 105.5}"#.utf8).write(to: PostedEvents.path(home: home))
        let w = try #require(PostedEvents.read(home: home))
        #expect(w.posts == [Date(timeIntervalSince1970: 100), Date(timeIntervalSince1970: 105.5)])
    }
    @Test func aStoredWindowLongerThan30SecondsIsCappedWhenRead() throws {
        let home = Fx.tempDir()
        try Data(#"{"start": 0, "end": 100, "posts": [0, 40, 80, 100]}"#.utf8).write(to: PostedEvents.path(home: home))
        let w = try #require(PostedEvents.read(home: home))
        #expect(w.posts == [Date(timeIntervalSince1970: 80), Date(timeIntervalSince1970: 100)])
    }
    @Test func missingOrDamagedFilesReadAsNoRecord() throws {
        let home = Fx.tempDir()
        #expect(PostedEvents.read(home: home) == nil)
        try Data("{broken".utf8).write(to: PostedEvents.path(home: home))
        #expect(PostedEvents.read(home: home) == nil)
        try Data(#"{"start": 5, "end": 1}"#.utf8).write(to: PostedEvents.path(home: home))
        #expect(PostedEvents.read(home: home) == nil, "an end before the start is not a window")
    }
}
