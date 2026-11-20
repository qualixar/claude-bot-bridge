import Foundation

/// A starting point for a rules profile of a new app version, built from the closest existing profile and what the
/// recorded tree actually contains. Matching is judged on the RAW tree (in memory); everything that is printed comes
/// from the redacted tree, so the draft never carries content.
public enum DraftProfile {
    public static let versionPlaceholder = "SET-THE-VERSION"
    static let maxCandidates = 3

    public static func make(raw: TreeNode, redacted: TreeNode, base: Profile, idPrefix: String, version: String?) -> (profile: [String: Any], notes: [String]) {
        var dict = ((try? JSONSerialization.jsonObject(with: JSONEncoder().encode(base))) as? [String: Any]) ?? [:]
        dict["id"] = "\(idPrefix)-\(version ?? "new")-draft"
        dict["match"] = ["versions": [version ?? versionPlaceholder]]
        var notes = ["copied from \(base.id): edit what differs, then check it with `muse-ax selftest` and the replay tests"]
        let probe = TreeProbe(root: raw, profile: base)
        let layout = probe.layout()
        if layout == .unknown { notes.append("layout: neither the sidebar element nor the chat switcher element matched (chat list hidden, or the app was redesigned)") }
        let needed = Set(layout == .unknown ? base.requiredElements(layout: .sidebar) + base.requiredElements(layout: .chatSwitcher) : base.requiredElements(layout: layout))
        for name in needed.sorted() where probe.find(name) == nil {
            let role = base.elements[name]?.role
            let found = candidates(role: role, raw: raw, redacted: redacted)
            notes.append("\(name): matched nothing in this tree" + (found.isEmpty ? "" : "; same-role nodes: " + found.joined(separator: ", ")))
        }
        return (dict, notes)
    }

    private static func candidates(role: String?, raw: TreeNode, redacted: TreeNode) -> [String] {
        guard let role = role else { return [] }
        var out: [String] = []
        // Raw and redacted trees have the same shape; walk them as pairs through the shared walker.
        typealias Pair = (raw: TreeNode, red: TreeNode)
        TreeWalk.walk(root: (raw, redacted), children: { (p: Pair) in Array(zip(p.raw.children, p.red.children)).map { (raw: $0, red: $1) } },
                      skip: { (p: Pair) in p.raw.role == "AXMenuBar" }) { (p: Pair) in
            if p.raw.role == role { out.append("\(p.red.role) \"\(p.red.effectiveTitle)\" at \(p.red.frame.x),\(p.red.frame.y) \(p.red.frame.w)x\(p.red.frame.h)") }
            return out.count >= maxCandidates
        }
        return out
    }
}
