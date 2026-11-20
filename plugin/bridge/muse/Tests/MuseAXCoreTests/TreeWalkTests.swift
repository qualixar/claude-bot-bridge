import Testing
import Foundation
@testable import MuseAXCore

/// Muse's live accessibility tree can contain a cycle (an element that is its own ancestor). The walker must end anyway.
@Suite struct TreeWalkTests {
    /// A graph given by adjacency lists; ids are the node identity.
    struct Graph {
        let edges: [Int: [Int]]
        func children(_ n: Int) -> [Int] { edges[n] ?? [] }
    }

    func walk(_ g: Graph, root: Int = 0, skip: @escaping (Int) -> Bool = { _ in false }, maxDepth: Int = TreeWalk.maxDepth,
              maxNodes: Int = TreeWalk.maxNodes, stopAt: Int? = nil) -> (order: [Int], result: TreeWalkResult) {
        var order: [Int] = []
        let r = TreeWalk.walk(root: root, children: g.children, key: { $0 }, skip: skip, maxDepth: maxDepth, maxNodes: maxNodes) { n in
            order.append(n); return n == stopAt
        }
        return (order, r)
    }

    @Test func aCycleTerminatesAndStillFindsTheNodesReachedBeforeIt() {
        // 0 -> 1 -> 2 -> 3 -> 1 (back edge), 0 -> 4
        let g = Graph(edges: [0: [1, 4], 1: [2], 2: [3], 3: [1]])
        let (order, r) = walk(g)
        #expect(order == [0, 1, 2, 3, 4])
        #expect(r.visited == 5 && r.stopped == .finished)
    }
    @Test func aSelfLoopTerminates() {
        let (order, r) = walk(Graph(edges: [0: [0, 1], 1: [1]]))
        #expect(order == [0, 1] && r.stopped == .finished)
    }
    @Test func aNodeThatIsItsOwnAncestorFarDownIsNotWalkedAgain() {
        var e: [Int: [Int]] = [:]
        for i in 0..<200 { e[i] = [i + 1] }
        e[200] = [0]   // the end points back at the root
        let (order, r) = walk(Graph(edges: e), maxDepth: 1000)
        #expect(order == Array(0...200) && r.stopped == .finished)
    }
    @Test func theDepthCapStopsTheDescentCleanly() {
        var e: [Int: [Int]] = [:]
        for i in 0..<500 { e[i] = [i + 1] }   // a chain far deeper than the cap
        let (order, r) = walk(Graph(edges: e), maxDepth: 64)
        #expect(order == Array(0...64), "the root is depth 0, the deepest visited node depth 64")
        #expect(r.stopped == .depthCap)
    }
    @Test func theDefaultCapsAre64DeepAnd20000Nodes() {
        #expect(TreeWalk.maxDepth == 64 && TreeWalk.maxNodes == 20_000)
    }
    @Test func theNodeCapStopsTheWalkAfterThatManyVisits() {
        var e: [Int: [Int]] = [0: Array(1...100)]   // wide, shallow
        for i in 1...100 { e[i] = [] }
        let (order, r) = walk(Graph(edges: e), maxNodes: 10)
        #expect(order == Array(0...9) && r.visited == 10 && r.stopped == .nodeCap)
    }
    @Test func aWalkOfExactlyTheCapIsNotReportedAsCut() {
        let (order, r) = walk(Graph(edges: [0: [1, 2]]), maxNodes: 3)
        #expect(order == [0, 1, 2] && r.stopped == .finished)
    }
    @Test func theVisitorCanStopTheWalk() {
        let g = Graph(edges: [0: [1, 2], 1: [3], 2: [4]])
        let (order, r) = walk(g, stopAt: 3)
        #expect(order == [0, 1, 3] && r.stopped == .found)
    }
    @Test func aSkippedNodeIsNeitherVisitedNorDescended() {
        let g = Graph(edges: [0: [1, 2], 1: [3], 2: [4]])
        #expect(walk(g, skip: { $0 == 1 }).order == [0, 2, 4])
    }
    @Test func aSharedNodeIsVisitedOnce() {
        let g = Graph(edges: [0: [1, 2], 1: [3], 2: [3], 3: [4]])
        #expect(walk(g).order == [0, 1, 3, 4, 2])
    }

    /// The old recursive depth-first walk, kept here as the reference the iterative one must match.
    func reference(_ g: Graph, _ n: Int, _ out: inout [Int]) {
        out.append(n)
        for c in g.children(n) { reference(g, c, &out) }
    }
    @Test func theOrderIsExactlyThePreOrderOfTheOldRecursiveWalkOnAnyTree() {
        var gen = SystemRandomNumberGenerator()
        for _ in 0..<50 {
            var edges: [Int: [Int]] = [:]
            let count = Int.random(in: 1...300, using: &gen)
            for id in 1..<max(count, 1) { edges[Int.random(in: 0..<id, using: &gen), default: []].append(id) }   // a random tree
            let g = Graph(edges: edges)
            var want: [Int] = []
            reference(g, 0, &want)
            #expect(walk(g).order == want)
        }
    }
    @Test func aValueTreeNeedsNoIdentity() {
        let tree = T.sidebarTree()
        var n = 0
        let r = TreeWalk.walk(root: tree, children: { $0.children }) { _ in n += 1; return false }
        #expect(n == tree.count && r.stopped == .finished)
    }

    // snapshot: copies a (possibly cyclic) graph into a finite TreeNode tree, as the live dump does.
    func copy(_ g: Graph, root: Int = 0, maxDepth: Int = TreeWalk.maxDepth, maxNodes: Int = TreeWalk.maxNodes) -> (tree: TreeNode?, result: TreeWalkResult) {
        TreeWalk.snapshot(root: root, children: g.children, key: { $0 }, maxDepth: maxDepth, maxNodes: maxNodes) { n, inherited in
            (TreeNode(role: "N\(n)", title: inherited ? "inherited" : nil), inherited || n == 1)
        }
    }
    @Test func aSnapshotOfACyclicGraphIsAFiniteTreeInTheSameOrder() throws {
        let (tree, r) = copy(Graph(edges: [0: [1, 4], 1: [2], 2: [3], 3: [1, 0]]))
        let t = try #require(tree)
        #expect(t.children.map(\.role) == ["N1", "N4"])
        #expect(t.children[0].children[0].children[0].role == "N3" && t.children[0].children[0].children[0].children.isEmpty)
        #expect(t.count == 5 && r.stopped == .finished)
    }
    @Test func theContextFlowsFromParentToChildrenOnly() throws {
        let t = try #require(copy(Graph(edges: [0: [1, 2], 1: [3], 2: [4]])).tree)
        // Node 1 switches the context on for its descendants; node 1 itself and its sibling branch do not inherit it.
        #expect(t.children[0].title == nil && t.children[0].children[0].title == "inherited" && t.children[1].children[0].title == nil)
    }
    @Test func aSnapshotOfAnAcyclicValueTreeEqualsTheSource() throws {
        let src = T.sidebarTree()
        let copied = try #require(TreeWalk.snapshot(root: src, children: { $0.children }) { n, _ in
            var m = n; m.children = []; return (m, false)
        }.tree)
        #expect(copied == src)
    }
    @Test func aSnapshotHonoursTheCaps() throws {
        var e: [Int: [Int]] = [:]
        for i in 0..<500 { e[i] = [i + 1] }
        let (tree, r) = copy(Graph(edges: e), maxDepth: 10)
        #expect(try #require(tree).count == 11 && r.stopped == .depthCap)
        #expect(copy(Graph(edges: e), maxNodes: 7).tree?.count == 7)
    }
}

/// Every traversal of the live tree goes through TreeWalk: a hand-written recursive one crashed the helper on a cyclic tree.
@Suite struct NoRecursiveTraversalTests {
    @Test func noLocalRecursiveGoFunctionsAndTheLiveFilesUseTheSharedWalker() throws {
        let dir = Fx.repoFile("plugin/bridge/muse/Sources")
        guard let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil) else { return }
        let files = (e.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }
        guard !files.isEmpty else { return }
        for f in files where f.lastPathComponent != "TreeWalk.swift" {
            let text = try String(contentsOf: f, encoding: .utf8)
            #expect(!text.contains("func go("), "\(f.lastPathComponent) has a local recursive walker")
        }
        let ax = try String(contentsOf: dir.appendingPathComponent("muse-ax/AX.swift"), encoding: .utf8)
        let cap = try String(contentsOf: dir.appendingPathComponent("muse-ax/TreeCapture.swift"), encoding: .utf8)
        #expect(ax.contains("TreeWalk.walk(") && cap.contains("TreeWalk.snapshot("))
    }
}
