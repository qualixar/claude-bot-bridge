import Foundation
import CoreGraphics

/// What the Accessibility hit test found under a screen point.
public struct ClickHit: Equatable {
    public let pid: Int32
    public let frame: CGRect
    public init(pid: Int32, frame: CGRect) { self.pid = pid; self.frame = frame }
}

public enum ClickTarget {
    /// A HID click goes to whatever is on top at that screen point. Before clicking:
    /// - the click point must lie inside the composer frame;
    /// - the element under the point must belong to Muse's process (no other app's window on top);
    /// - that element must either sit inside the composer, or be a container holding the whole composer (the
    ///   window or web area: Muse's native text input is not in the accessibility tree, so the hit test often
    ///   returns its container). Anything else of Muse's partly covering the point (a popover) is refused.
    public static func validate(hit: ClickHit?, musePid: Int32, composer: CGRect, point: CGPoint? = nil,
                                tolerance: CGFloat = 6) throws {
        guard let hit else {
            throw MuseError.clickTargetMismatch("nothing in Muse's accessibility tree is under the click point.")
        }
        guard hit.pid == musePid else {
            throw MuseError.clickTargetMismatch("another app (pid \(hit.pid)) is on top at the click point.")
        }
        let allowed = composer.insetBy(dx: -tolerance, dy: -tolerance)
        if let point, !allowed.contains(point) {
            throw MuseError.clickTargetMismatch("the click point is outside the composer (\(describe(composer))).")
        }
        let inside = allowed.contains(hit.frame)
        let holdsComposer = hit.frame.insetBy(dx: -tolerance, dy: -tolerance).contains(composer)
        guard !hit.frame.isEmpty, inside || holdsComposer else {
            throw MuseError.clickTargetMismatch("the element under the click point (\(describe(hit.frame))) is not the composer or a container of it (\(describe(composer))).")
        }
    }

    static func describe(_ r: CGRect) -> String { "\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width))x\(Int(r.height))" }
}
