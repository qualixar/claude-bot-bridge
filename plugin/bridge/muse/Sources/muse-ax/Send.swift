import ApplicationServices
import AppKit
import MuseAXCore

/// Types into Muse's native composer with HID-level events (no clipboard for the message itself).
/// What may be typed, and when Return may be pressed, is decided by `SendFlow` (unit-tested with fakes);
/// this file only performs the steps against the live app.
enum Typist {
    static func send(chat: String, text: String, dryRun: Bool = false, muse m: MuseApp) throws {
        let app = m.app
        guard LiveSendDriver.composerFrame(m) != nil else { throw MuseError.composerNotFound }
        let prev = NSWorkspace.shared.frontmostApplication
        let mouse = CGEvent(source: nil)?.location ?? .zero
        // Registered first, so it runs last: it records the moment of every click and key we post, however the send ends.
        // The idle guard of the NEXT send uses them to tell our own events from the user's input.
        let posts = PostLog()
        defer { if let w = posts.window() { try? PostedEvents.record(w, home: RulesStore.home()) } }
        defer { CGWarpMouseCursorPosition(mouse); if prev?.processIdentifier != app.processIdentifier { prev?.activate() } }
        guard bringToFront(app) else {
            throw MuseError.inputFailed("Muse did not come to the front; nothing was typed.")
        }
        try SendFlow.perform(chat: chat, text: text, driver: LiveSendDriver(muse: m, posts: posts), dryRun: dryRun)
    }

    /// macOS 14+ may ignore activate() from a CLI process (cooperative activation).
    /// Fall back to Accessibility: raise the main window and set AXFrontmost.
    private static func bringToFront(_ app: NSRunningApplication) -> Bool {
        // NSWorkspace.frontmostApplication is refreshed only by the run loop, which a CLI
        // doesn't spin while sleeping, so read the live AXFrontmost flag instead.
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        func isFront() -> Bool {
            var v: AnyObject?
            AXUIElementCopyAttributeValue(ax, kAXFrontmostAttribute as CFString, &v)
            return (v as? Bool) == true
        }
        app.activate(); usleep(600_000)
        if isFront() { return true }
        var wins: AnyObject?
        AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &wins)
        if let w = (wins as? [AXUIElement])?.first {
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        for _ in 0..<10 { usleep(150_000); if isFront() { return true } }
        return false
    }
}

/// The time of every event the helper posts during one send (see `PostedWindow`). Each live post marks it.
final class PostLog {
    private var times: [Date] = []
    func mark() { times.append(Date()) }
    func window() -> PostedWindow? { times.isEmpty ? nil : PostedWindow(posts: times) }
}

/// The live implementation of the send steps. Every posted event carries explicit modifier flags (empty unless a
/// shortcut needs one), so a key the user happens to be holding cannot leak into the message.
struct LiveSendDriver: SendDriver {
    let muse: MuseApp
    let posts: PostLog
    private var pid: pid_t { muse.app.processIdentifier }
    private var src: CGEventSource? { CGEventSource(stateID: .hidSystemState) }

    static func composerFrame(_ m: MuseApp) -> CGRect? {
        guard let c = m.composer() else { return nil }
        let f = AX.frame(c)
        return f.width > 200 && f.height > 10 ? f : nil
    }

    private var clickPoint: CGPoint? {
        Self.composerFrame(muse).map { CGPoint(x: $0.minX + 0.4 * $0.width, y: $0.midY) }
    }

    func currentChat() -> String? { muse.currentChat() }

    // MARK: focus

    /// The composer's native text input is not in the accessibility tree, but when it has keyboard focus the app's
    /// focused element may be it. Only a focused text element lying over the composer counts.
    private func focusedTextInput() -> AXUIElement? {
        guard let f = Self.composerFrame(muse), let raw = AX.attr(muse.ax, kAXFocusedUIElementAttribute),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let e = raw as! AXUIElement
        var p: pid_t = 0
        AXUIElementGetPid(e, &p)
        guard p == pid, ["AXTextArea", "AXTextField", "AXComboBox"].contains(AX.role(e)),
              AX.attr(e, kAXValueAttribute) is String, AX.frame(e).intersects(f) else { return nil }
        return e
    }

    func focusViaAccessibility() -> Bool {
        guard let c = muse.composer() else { return false }
        guard AXUIElementSetAttributeValue(c, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { return false }
        usleep(200_000)
        return focusedTextInput() != nil
    }

    func checkClickTarget() throws {
        guard let f = Self.composerFrame(muse), let p = clickPoint else { throw MuseError.composerNotFound }
        var hit: AXUIElement?
        let ok = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success
        var hitPid: pid_t = 0
        if ok, let h = hit { AXUIElementGetPid(h, &hitPid) }
        let result = (ok ? hit : nil).map { ClickHit(pid: hitPid, frame: AX.frame($0)) }
        try ClickTarget.validate(hit: result, musePid: pid, composer: f, point: p)
    }

    func click() {
        guard let p = clickPoint else { return }
        for t in [CGEventType.leftMouseDown, .leftMouseUp] {
            let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)
            e?.flags = []
            e?.post(tap: .cghidEventTap)
            posts.mark()
            usleep(90_000)
        }
        usleep(400_000)
    }

    // MARK: reading the composer

    func readComposer() -> String? {
        if let e = focusedTextInput(), let v = AX.attr(e, kAXValueAttribute) as? String { return v }
        return readByCopy()
    }

    /// Fallback when the text input is invisible to Accessibility: select all, copy, read the clipboard, put the
    /// previous clipboard back. A sentinel tells "nothing was copied" (empty or unreadable) from real text.
    private func readByCopy() -> String? {
        let pb = NSPasteboard.general
        let saved = ClipboardSnapshot(pb)
        defer { saved.restore(to: pb) }
        let sentinel = "cbb-sentinel-\(UUID().uuidString)"
        pb.clearContents()
        pb.setString(sentinel, forType: .string)
        let count = pb.changeCount
        key(0, flags: .maskCommand)      // A
        usleep(120_000)
        key(8, flags: .maskCommand)      // C
        usleep(250_000)
        guard pb.changeCount != count, let s = pb.string(forType: .string), s != sentinel else { return "" }
        key(124, flags: [])               // Right arrow: collapse the selection so the next typing does not replace it
        usleep(60_000)
        return s
    }

    // MARK: typing

    func type(_ chunks: [[UInt16]]) {
        for chunk in chunks {
            var units = chunk
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
                e?.flags = []
                e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                e?.postToPid(pid)
                posts.mark()
                usleep(12_000)
            }
        }
        usleep(250_000)
    }

    func clearComposer() {
        key(0, flags: .maskCommand)       // select all
        usleep(100_000)
        key(51, flags: [])                // delete
        usleep(150_000)
    }

    func pressReturn() {
        key(36, flags: [])
        usleep(500_000)
    }

    private func key(_ code: CGKeyCode, flags: CGEventFlags) {
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
            e?.flags = flags
            e?.postToPid(pid)
            posts.mark()
            usleep(40_000)
        }
    }
}

/// Every item and type on the general pasteboard, so it can be put back after the copy-based read.
private struct ClipboardSnapshot {
    private let items: [[NSPasteboard.PasteboardType: Data]]

    init(_ pb: NSPasteboard) {
        items = (pb.pasteboardItems ?? []).map { item in
            var d: [NSPasteboard.PasteboardType: Data] = [:]
            for t in item.types { if let data = item.data(forType: t) { d[t] = data } }
            return d
        }
    }

    func restore(to pb: NSPasteboard) {
        pb.clearContents()
        let restored = items.map { entry -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (t, data) in entry { item.setData(data, forType: t) }
            return item
        }
        if !restored.isEmpty { pb.writeObjects(restored) }
    }
}
