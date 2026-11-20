import Foundation

public struct TreeFrame: Codable, Equatable {
    public var x: Int, y: Int, w: Int, h: Int
    public init(x: Int, y: Int, w: Int, h: Int) { self.x = x; self.y = y; self.w = w; self.h = h }
}

/// One accessibility element as `muse-ax doctor --dump-tree` records it. `title`, `value` and `description` are nil
/// when the attribute is absent (the live helper reads a title as `title ?? description ?? ""`).
public struct TreeNode: Codable, Equatable {
    public var role: String
    public var subrole: String?
    public var identifier: String?
    public var title: String?
    public var value: String?
    public var description: String?
    public var frame: TreeFrame
    public var children: [TreeNode]

    public init(role: String, subrole: String? = nil, identifier: String? = nil, title: String? = nil, value: String? = nil,
                description: String? = nil, frame: TreeFrame = TreeFrame(x: 0, y: 0, w: 0, h: 0), children: [TreeNode] = []) {
        self.role = role; self.subrole = subrole; self.identifier = identifier; self.title = title; self.value = value
        self.description = description; self.frame = frame; self.children = children
    }

    public var count: Int { 1 + children.reduce(0) { $0 + $1.count } }

    /// What profile matchers see as the title.
    public var effectiveTitle: String { title ?? description ?? "" }
    public var effectiveValue: String { value ?? "" }

    public func node(at path: [Int]) -> TreeNode? {
        guard let i = path.first else { return self }
        return children.indices.contains(i) ? children[i].node(at: Array(path.dropFirst())) : nil
    }
}

/// The file `--dump-tree` writes, and the shape of the recorded fixtures in test-fixtures/trees/.
public struct TreeDocument: Codable, Equatable {
    public static let format = "cbb-ax-tree/1"
    public var format: String
    public var museVersion: String?
    public var redacted: Bool
    public var source: String?
    public var tree: TreeNode

    enum CodingKeys: String, CodingKey { case format, museVersion = "muse_version", redacted, source, tree }

    public init(museVersion: String?, redacted: Bool, source: String? = nil, tree: TreeNode) {
        self.format = TreeDocument.format; self.museVersion = museVersion; self.redacted = redacted; self.source = source; self.tree = tree
    }
}

/// What a dump produced (counts only, never content).
public struct TreeDumpResult {
    public let path: URL
    public let nodes: Int
    public let hashed: Int
    public let dropped: Int
    public let kept: Int
    public let truncated: Bool
    public let draftProfile: [String: Any]
    public let notes: [String]

    public init(path: URL, nodes: Int, hashed: Int, dropped: Int, kept: Int, truncated: Bool, draftProfile: [String: Any], notes: [String]) {
        self.path = path; self.nodes = nodes; self.hashed = hashed; self.dropped = dropped; self.kept = kept
        self.truncated = truncated; self.draftProfile = draftProfile; self.notes = notes
    }
}
