import Testing
import Foundation
@testable import MuseAXCore

/// `doctor --dump-tree` writes a tree that may be pasted into a public issue: no message text, no chat names.
@Suite struct RedactorTests {
    let secrets = ["Project Phoenix", "Tax return 2026", "my secret plan", "buy the tickets", "search text typed", "assistant answer"]
    func redact(_ t: TreeNode, _ p: Profile = Fx.p12, salt: String = "s1") -> (tree: TreeNode, stats: RedactStats) {
        Redactor.redact(t, profile: p, salt: salt)
    }

    @Test func noMessageTextAndNoChatNameSurvivesInTheOutput() {
        let out = T.json(redact(T.sidebarTree()).tree)
        for s in secrets { #expect(!out.contains(s), "leaked: \(s)") }
        // Not even a fragment of a chat name inside the composer title or the window title.
        #expect(!out.contains("Phoenix") && !out.contains("Tax") && !out.contains("2026") && !out.contains("salary"))
    }
    @Test func theSwitcherLayoutIsRedactedTheSame() {
        let out = T.json(redact(T.switcherTree(), Fx.p13).tree)
        for s in ["Project Phoenix", "private question", "salary", "a reply"] { #expect(!out.contains(s), "leaked: \(s)") }
    }
    @Test func structureRolesAndFramesAreKept() {
        let raw = T.sidebarTree(), red = redact(raw).tree
        #expect(red.count == raw.count)
        let web = red.children[0].children[0]
        #expect(web.role == "AXWebArea" && web.frame == TreeFrame(x: 100, y: 70, w: 1000, h: 670))
        #expect(red.children[1].role == "AXMenuBar")
    }
    // AXIdentifier is page-controlled text (DOM ids, test ids): it can carry a chat title or a user id, so it is hashed
    // unless the rules list it as a structural identifier.
    @Test func identifiersAreHashedUnlessTheRulesListThem() {
        let web = redact(T.sidebarTree()).tree.children[0].children[0]
        #expect(web.identifier?.hasPrefix("h:") == true && web.identifier != "root-web", "no structural identifiers in the rules: hashed")
        var p = Fx.p12; p.structuralIdentifiers = ["root-web"]
        #expect(redact(T.sidebarTree(), p).tree.children[0].children[0].identifier == "root-web")
        var other = Fx.p12; other.structuralIdentifiers = ["something-else"]
        #expect(redact(T.sidebarTree(), other).tree.children[0].children[0].identifier?.hasPrefix("h:") == true)
    }
    @Test func anIdentifierThatCarriesPrivateTextNeverSurvives() {
        var t = T.sidebarTree()
        t.children[0].children[0].children[0].children[2].identifier = "chat-Project Phoenix-user-4711"
        t.children[0].children[0].children[0].children[3].identifier = "Tax return 2026"   // equals a chat name
        var p = Fx.p12; p.structuralIdentifiers = ["root-web"]
        let out = T.json(redact(t, p).tree)
        for s in ["Phoenix", "4711", "Tax return"] { #expect(!out.contains(s), "leaked: \(s)") }
    }
    @Test func equalIdentifiersGetEqualHashesInsideOneDumpAndDifferentOnesNot() {
        var t = T.sidebarTree()
        t.children[0].children[0].children[0].children[2].identifier = "row"
        t.children[0].children[0].children[0].children[3].identifier = "row"
        t.children[0].children[0].children[0].children[4].identifier = "other"
        let side = redact(t).tree.children[0].children[0].children[0]
        #expect(side.children[2].identifier == side.children[3].identifier && side.children[2].identifier != side.children[4].identifier)
        #expect(redact(t, salt: "s2").tree.children[0].children[0].children[0].children[2].identifier != side.children[2].identifier)
    }
    @Test func emptyIdentifiersStayEmptyAndMissingOnesStayMissing() {
        var t = T.sidebarTree()
        t.children[0].children[0].children[0].children[1].identifier = ""
        let side = redact(t).tree.children[0].children[0].children[0]
        #expect(side.children[1].identifier == "" && side.children[2].identifier == nil)
    }
    @Test func structuralIdentifiersAreOptionalInTheRulesFile() throws {
        #expect(Fx.p12.structuralIdentifiers == nil)
        var p = Fx.p12; p.structuralIdentifiers = ["root-web"]
        let back = try JSONDecoder().decode(Profile.self, from: JSONEncoder().encode(p))
        #expect(back.structuralIdentifiers == ["root-web"])
        #expect(String(decoding: try JSONEncoder().encode(p), as: UTF8.self).contains("\"structural_identifiers\""))
    }
    @Test func allowlistedUiLabelsStayReadable() {
        let side = redact(T.sidebarTree()).tree.children[0].children[0].children[0]
        #expect(side.title == "Side chats")
        #expect(side.children.map(\.title) == ["", "Main chat", side.children[2].title, side.children[3].title, "Channels", "Search", "New side chat"])
        #expect(redact(T.sidebarTree()).tree.children[0].children[0].children[1].title == "Chat messages")
    }
    @Test func aLabelNotOnTheAllowlistIsHashed() {
        var t = T.sidebarTree()
        t.children[0].children[0].children.append(T.n("AXButton", "Brand new Meta feature"))
        let added = redact(t).tree.children[0].children[0].children.last!
        #expect(added.title?.hasPrefix("h:") == true && added.title?.contains("Meta") == false)
    }
    @Test func chatNamesAreAlwaysHashedAndTheSameNameGetsTheSameHashEverywhere() {
        let red = redact(T.sidebarTree()).tree
        let sidebar = red.children[0].children[0].children[0]
        let phoenix = sidebar.children[2].title!, tax = sidebar.children[3].title!
        #expect(phoenix.hasPrefix("h:") && tax.hasPrefix("h:") && phoenix != tax)
        #expect(red.children[0].title == phoenix, "window title is the same chat name")
        let composer = red.children[0].children[0].children[2].title!
        #expect(composer == "Message in \(phoenix) Attach files Send")
    }
    @Test func theMainChatLabelIsStructuralNotAChatName() {
        #expect(redact(T.sidebarTree()).tree.children[0].children[0].children[0].children[1].title == "Main chat")
    }
    @Test func hashesDependOnTheSaltAndNotOnAnythingElse() {
        let a = redact(T.sidebarTree(), salt: "one").tree.children[0].title
        let b = redact(T.sidebarTree(), salt: "one").tree.children[0].title
        let c = redact(T.sidebarTree(), salt: "two").tree.children[0].title
        #expect(a == b && a != c && a?.count == 10)   // "h:" + 8 hex
    }
    @Test func messageTextIsDroppedEvenWhenItEqualsAnAllowlistedLabel() {
        let group = redact(T.sidebarTree()).tree.children[0].children[0].children[1]
        let texts = group.children.flatMap(\.children).compactMap(\.title)
        #expect(texts == ["<message>", "<message>", "<message>", "<message>", "<message>"])
        #expect(!T.json(group).contains("Send"))
    }
    @Test func valuesAndDescriptionsAreRedactedToo() {
        var t = T.sidebarTree()
        t.children[0].children[0].children[0].children[0] = T.n("AXTextField", "", value: "typed secret", desc: "secret description")
        let field = redact(t).tree.children[0].children[0].children[0].children[0]
        #expect(field.value?.hasPrefix("h:") == true && field.description?.hasPrefix("h:") == true && field.title == "")
    }
    @Test func composerWordsStayWhenEveryWordIsAKnownUiWord() {
        let c = redact(T.switcherTree(open: nil), Fx.p13).tree.children[0].children[0].children[2]
        #expect(c.title == "Message Attach file Dictate a message Send")
        let named = redact(T.switcherTree(), Fx.p13).tree.children[0].children[0].children[2].title!
        #expect(named.hasPrefix("Message in h:") && named.hasSuffix(" Attach file Dictate a message Send"))
    }
    @Test func aComposerRemainderWithUnknownWordsIsHashedWhole() {
        var t = T.switcherTree()
        t.children[0].children[0].children[2].title = "Message in Project Phoenix Attach file Dictate a message Send gossip"
        let title = redact(t, Fx.p13).tree.children[0].children[0].children[2].title!
        #expect(!title.contains("gossip") && title.hasPrefix("Message in h:"))
    }
    @Test func theOutputIsAPureFunctionOfTheInput() {
        #expect(redact(T.sidebarTree()).tree == redact(T.sidebarTree()).tree)
    }
    @Test func statsCountWithoutRevealing() {
        let r = redact(T.sidebarTree())
        #expect(r.stats.nodes == T.sidebarTree().count && r.stats.dropped == 5 && r.stats.hashed > 0 && r.stats.kept > 0)
    }
    @Test func theAllowlistComesFromTheRulesAndNothingElse() {
        let policy = RedactionPolicy(profile: Fx.p12)
        for s in ["Side chats", "New side chat", "Main chat", "Channels", "Search", "Cancel"] { #expect(policy.allowlist.contains(s), "\(s)") }
        for s in ["Project Phoenix", "Tax return 2026", ""] { #expect(!policy.allowlist.contains(s), "\(s)") }
        #expect(policy.vocabulary.isSuperset(of: ["Attach", "file", "Send", "Message", "in"]))
        #expect(policy.identifiers.isEmpty)
        var p = Fx.p12; p.structuralIdentifiers = ["a", "b"]
        #expect(RedactionPolicy(profile: p).identifiers == ["a", "b"])
    }
    @Test func rulesWithoutLabelsStillRedactSafely() {
        var p = Fx.p12; p.labels = nil
        let out = T.json(redact(T.sidebarTree(), p).tree)
        for s in secrets { #expect(!out.contains(s)) }
    }
}
