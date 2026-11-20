import Foundation

public struct TreeWalkResult: Equatable {
    public enum Stop: Equatable {
        /// The whole reachable tree was walked.
        case finished
        /// The visitor asked to stop (it found what it wanted).
        case found
        /// Some nodes lay deeper than `maxDepth` and were left out.
        case depthCap
        /// The walk stopped because `maxNodes` nodes had been visited and more were waiting.
        case nodeCap
    }
    public let visited: Int
    public let stopped: Stop
}

/// The one depth-first walker behind every accessibility traversal (finders, anchors, the tree dump). Muse's live tree can
/// contain a cycle, and a recursive walk followed it until the stack guard killed the process. This walk has no recursion
/// (an explicit stack), never visits a node twice (when it is given a `key` that identifies a node), and ends at a depth
/// cap and a node cap, cleanly. The order is the pre-order of the plain recursive walk it replaces: a node is visited
/// before its children, children in order.
public enum TreeWalk {
    public static let maxDepth = 64
    public static let maxNodes = 20_000

    /// Where a visited node sits: its number in visiting order, its parent's number and its depth.
    public struct Place { public let index: Int; public let parent: Int?; public let depth: Int }

    /// - key: identity of a node, to cut cycles and shared nodes. Leave nil for value trees (they cannot be cyclic).
    /// - skip: a node that is neither visited nor descended into (the menu bar).
    /// - visit: returns true to stop the walk.
    @discardableResult
    public static func walk<N>(root: N, children: (N) -> [N], key: ((N) -> AnyHashable)? = nil, skip: ((N) -> Bool)? = nil,
                               maxDepth: Int = TreeWalk.maxDepth, maxNodes: Int = TreeWalk.maxNodes,
                               visit: (N) -> Bool) -> TreeWalkResult {
        walkPlaced(root: root, children: children, key: key, skip: skip, maxDepth: maxDepth, maxNodes: maxNodes) { n, _ in visit(n) }
    }

    /// Same walk, telling the visitor where each node sits (so a tree can be rebuilt from the visits).
    @discardableResult
    public static func walkPlaced<N>(root: N, children: (N) -> [N], key: ((N) -> AnyHashable)? = nil, skip: ((N) -> Bool)? = nil,
                                     maxDepth: Int = TreeWalk.maxDepth, maxNodes: Int = TreeWalk.maxNodes,
                                     visit: (N, Place) -> Bool) -> TreeWalkResult {
        var stack: [(node: N, depth: Int, parent: Int?)] = [(root, 0, nil)]
        var seen = Set<AnyHashable>()
        var visited = 0
        var depthCut = false
        while let (node, depth, parent) = stack.popLast() {
            if depth > maxDepth { depthCut = true; continue }
            if let skip = skip, skip(node) { continue }
            if let key = key, !seen.insert(key(node)).inserted { continue }
            if visited >= maxNodes { return TreeWalkResult(visited: visited, stopped: .nodeCap) }
            let place = Place(index: visited, parent: parent, depth: depth)
            visited += 1
            if visit(node, place) { return TreeWalkResult(visited: visited, stopped: .found) }
            // Reversed, so the first child is popped (and visited) first.
            for c in children(node).reversed() { stack.append((c, depth + 1, place.index)) }
        }
        return TreeWalkResult(visited: visited, stopped: depthCut ? .depthCap : .finished)
    }

    /// Copies a tree node by node through `make`, which receives the source node and its parent's context flag and returns the
    /// new node (without children) and the context flag its own children inherit. Same caps, cycle cut and order as `walk`;
    /// nothing is recursive. Nodes beyond a cap are left out.
    public static func snapshot<N>(root: N, children: (N) -> [N], key: ((N) -> AnyHashable)? = nil, skip: ((N) -> Bool)? = nil,
                                   maxDepth: Int = TreeWalk.maxDepth, maxNodes: Int = TreeWalk.maxNodes,
                                   make: (N, Bool) -> (node: TreeNode, context: Bool)) -> (tree: TreeNode?, result: TreeWalkResult) {
        var nodes: [TreeNode] = [], parents: [Int?] = [], contexts: [Bool] = []
        let r = walkPlaced(root: root, children: children, key: key, skip: skip, maxDepth: maxDepth, maxNodes: maxNodes) { n, place in
            let made = make(n, place.parent.map { contexts[$0] } ?? false)
            nodes.append(made.node); parents.append(place.parent); contexts.append(made.context)
            return false
        }
        guard !nodes.isEmpty else { return (nil, r) }
        // Parents come before their children in visiting order, so building from the end finds every child ready.
        var kids = [[TreeNode]](repeating: [], count: nodes.count)
        for i in stride(from: nodes.count - 1, through: 1, by: -1) {
            var n = nodes[i]
            n.children = Array(kids[i].reversed())
            kids[parents[i]!].append(n)
        }
        nodes[0].children = Array(kids[0].reversed())
        return (nodes[0], r)
    }
}
