import ApplicationServices
import MuseAXCore

/// Reads the live accessibility tree into `TreeNode`s (in memory only; `Redactor` runs before anything is written).
/// Inside the messages group the text attributes are not even read: they would be dropped anyway.
enum TreeCapture {
    struct Snapshot { let root: TreeNode; let nodes: Int; let truncated: Bool }

    static func snapshot(_ root: AXUIElement, messages: ElementMatcher?) -> Snapshot {
        func str(_ e: AXUIElement, _ a: String) -> String? { AX.attr(e, a) as? String }
        let r = TreeWalk.snapshot(root: root, children: AX.children, key: { AX.Key(element: $0) }, skip: { AX.role($0) == "AXMenuBar" }) { e, inMessages in
            let f = AX.frame(e)
            let isGroup = messages.map { AX.matches(e, $0) } ?? false
            let node = TreeNode(role: AX.role(e), subrole: str(e, kAXSubroleAttribute), identifier: str(e, "AXIdentifier"),
                                title: inMessages ? nil : str(e, kAXTitleAttribute), value: inMessages ? nil : str(e, kAXValueAttribute),
                                description: inMessages ? nil : str(e, kAXDescriptionAttribute),
                                frame: TreeFrame(x: Int(f.minX), y: Int(f.minY), w: Int(f.width), h: Int(f.height)))
            return (node, inMessages || isGroup)
        }
        let cut = r.result.stopped == .depthCap || r.result.stopped == .nodeCap
        return Snapshot(root: r.tree ?? TreeNode(role: "AXApplication"), nodes: r.result.visited, truncated: cut)
    }
}
