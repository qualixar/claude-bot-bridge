import ApplicationServices
import AppKit
import MuseAXCore

/// Thin wrappers over the Accessibility C API.
enum AX {
    static func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
        var v: AnyObject?
        AXUIElementCopyAttributeValue(e, a as CFString, &v)
        return v
    }
    static func role(_ e: AXUIElement) -> String { (attr(e, kAXRoleAttribute) as? String) ?? "" }
    static func title(_ e: AXUIElement) -> String {
        (attr(e, kAXTitleAttribute) as? String) ?? (attr(e, kAXDescriptionAttribute) as? String) ?? ""
    }
    static func matches(_ e: AXUIElement, _ m: ElementMatcher) -> Bool {
        m.matches(role: role(e), title: { title(e) }, childRoles: { children(e).map(role) })
    }
    static func value(_ e: AXUIElement) -> String { (attr(e, kAXValueAttribute) as? String) ?? "" }
    static func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
    static func frame(_ e: AXUIElement) -> CGRect {
        var p = CGPoint.zero, s = CGSize.zero
        if let pv = attr(e, kAXPositionAttribute), CFGetTypeID(pv) == AXValueGetTypeID() { AXValueGetValue(pv as! AXValue, .cgPoint, &p) }
        if let sv = attr(e, kAXSizeAttribute), CFGetTypeID(sv) == AXValueGetTypeID() { AXValueGetValue(sv as! AXValue, .cgSize, &s) }
        return CGRect(origin: p, size: s)
    }

    /// Identity of an element for cycle detection: AXUIElements are CF objects, equal when CFEqual says so.
    struct Key: Hashable {
        let element: AXUIElement
        static func == (a: Key, b: Key) -> Bool { CFEqual(a.element, b.element) }
        func hash(into h: inout Hasher) { h.combine(CFHash(element)) }
    }

    /// Depth-first walk (skips the menu bar). `visit` returns true to stop. Muse's tree can contain a cycle, so this goes
    /// through the shared walker in MuseAXCore: no recursion, every element once, capped in depth and size.
    @discardableResult
    static func walk(_ root: AXUIElement, _ visit: (AXUIElement) -> Bool) -> TreeWalkResult {
        TreeWalk.walk(root: root, children: children, key: { Key(element: $0) }, skip: { role($0) == "AXMenuBar" }, visit: visit)
    }

    static func first(_ root: AXUIElement, _ pred: (AXUIElement) -> Bool) -> AXUIElement? {
        var found: AXUIElement?
        walk(root) { if pred($0) { found = $0; return true }; return false }
        return found
    }

    static func all(_ root: AXUIElement, _ pred: (AXUIElement) -> Bool) -> [AXUIElement] {
        var out: [AXUIElement] = []
        walk(root) { if pred($0) { out.append($0) }; return false }
        return out
    }
}

/// A live handle to the Muse app with the web accessibility tree switched on, interpreted through one profile.
struct MuseApp {
    let app: NSRunningApplication
    let ax: AXUIElement
    var profile: Profile

    static func trusted() -> Bool { AXIsProcessTrusted() }

    static func running() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: MuseDriver.bundleID).first
    }

    /// Throws notRunning / notTrusted; enables AXEnhancedUserInterface.
    static func connect(profile: Profile) throws -> MuseApp {
        guard let app = running() else { throw MuseError.notRunning }
        guard trusted() else { throw MuseError.notTrusted }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetAttributeValue(ax, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        usleep(400_000)
        return MuseApp(app: app, ax: ax, profile: profile)
    }

    func with(_ p: Profile) -> MuseApp { MuseApp(app: app, ax: ax, profile: p) }

    var window: AXUIElement? { (AX.attr(ax, kAXWindowsAttribute) as? [AXUIElement])?.first }

    /// First element in the tree (or under `root`) that fits the profile's matcher called `name`.
    func find(_ name: String, under root: AXUIElement? = nil) -> AXUIElement? {
        guard let m = profile.elements[name] else { return nil }
        return AX.first(root ?? ax) { AX.matches($0, m) }
    }

    func findAll(_ name: String, under root: AXUIElement) -> [AXUIElement] {
        guard let m = profile.elements[name] else { return [] }
        return AX.all(root) { AX.matches($0, m) }
    }

    /// A direct child of the window that fits the matcher called `name` (sheets and dialogs hang there).
    func windowChild(_ name: String) -> AXUIElement? {
        guard let w = window, let m = profile.elements[name] else { return nil }
        return AX.children(w).first { AX.matches($0, m) }
    }

    func openSheet() -> AXUIElement? { windowChild("sheet") }

    func composer() -> AXUIElement? { find("composer") }

    /// True when the composer is idle (ready to accept a new message).
    func composerIdle() -> Bool { composer().map { ChatNames.composerIdle(title: AX.title($0), rules: profile.composer) } ?? false }

    func messagesGroup() -> AXUIElement? { find("chat_messages_group") }
}
