import Foundation
import CryptoKit

public struct RedactStats: Equatable {
    public var nodes = 0
    public var kept = 0
    public var hashed = 0
    public var dropped = 0
}

/// What may stay readable in a shared tree: whole UI strings that are fixed parts of the app, taken from the rules
/// (the profile's `labels`, every `equals` / `notIn` of its element matchers, the composer words). `vocabulary` is the
/// set of single words of those strings plus the prefixes, suffixes and fragments the rules look for; it lets a
/// composer title keep its fixed words around a hashed chat name. `identifiers` are the AXIdentifier values the rules declare structural.
public struct RedactionPolicy {
    public let allowlist: Set<String>
    public let vocabulary: Set<String>
    public let identifiers: Set<String>
    public let mainChatName: String

    public init(profile p: Profile) {
        var whole = Set(p.labels ?? [])
        var fragments = Set<String>()
        for m in p.elements.values {
            guard let t = m.title else { continue }
            if let e = t.equals { whole.insert(e) }
            whole.formUnion(t.notIn ?? [])
            for f in [t.prefix, t.suffix, t.contains].compactMap({ $0 }) { fragments.insert(f.trimmingCharacters(in: .whitespaces)) }
        }
        whole.insert(p.composer.mainChatName)
        whole.insert(p.composer.idleSuffix)
        for f in [p.composer.named.prefix, p.composer.named.terminator] { fragments.insert(f.trimmingCharacters(in: .whitespaces)) }
        for f in [p.composer.unnamedTitle.prefix, p.composer.unnamedTitle.contains].compactMap({ $0 }) { fragments.insert(f.trimmingCharacters(in: .whitespaces)) }
        whole.remove("")
        allowlist = whole
        vocabulary = Set(whole.union(fragments).flatMap { $0.split(separator: " ").map(String.init) })
        mainChatName = p.composer.mainChatName
        identifiers = Set(p.structuralIdentifiers ?? [])
    }
}

/// Redaction of a raw accessibility tree. Roles, subroles and frames are kept (they are the structure the rules depend on).
/// An identifier is kept only when the rules list it as structural (`structural_identifiers`); every other one is hashed,
/// because identifiers are page-controlled text and can carry a chat title or a user id. Every title, value and description
/// is replaced, except:
///  - empty strings, which carry no content;
///  - whole strings on the allowlist (fixed UI labels from the rules);
///  - the words of the composer title, around a hashed chat name, when every word is a known UI word.
/// A string equal to a chat name is always hashed (the one exception is "Main chat", Muse's own fixed label, not a name
/// anyone chose). Text anywhere inside the messages group is dropped (`<message>`), whatever it says. Hashes are the
/// first 8 hex digits of SHA-256 over a per-dump salt and the string: stable inside one dump so equal names can be
/// matched, different between dumps so a hash cannot be looked up in a dictionary of names. The salt is never written.
public enum Redactor {
    public static let droppedMarker = "<message>"

    public static func newSalt() -> String { UUID().uuidString }

    public static func redact(_ root: TreeNode, profile: Profile, salt: String) -> (tree: TreeNode, stats: RedactStats) {
        let policy = RedactionPolicy(profile: profile)
        let probe = TreeProbe(root: root, profile: profile)
        var names = Set(probe.chatNames())
        if let c = probe.currentChat() { names.insert(c) }
        names.remove(policy.mainChatName)
        let ctx = Context(salt: salt, policy: policy, chatNames: names, composer: profile.composer, messages: profile.elements["chat_messages_group"])
        var stats = RedactStats()
        let out = TreeWalk.snapshot(root: root, children: { $0.children }) { n, inMessages in
            redactNode(n, inMessages: inMessages, ctx, &stats)
        }.tree ?? root
        return (out, stats)
    }

    private struct Context {
        let salt: String, policy: RedactionPolicy, chatNames: Set<String>, composer: ComposerRules, messages: ElementMatcher?
    }

    static func hash(_ s: String, salt: String) -> String {
        let d = SHA256.hash(data: Data((salt + "\u{0}" + s).utf8))
        return "h:" + d.prefix(4).map { String(format: "%02x", $0) }.joined()
    }

    /// One node, without its children; `context` is what its children inherit (inside the messages group or not).
    private static func redactNode(_ n: TreeNode, inMessages: Bool, _ c: Context, _ stats: inout RedactStats) -> (node: TreeNode, context: Bool) {
        stats.nodes += 1
        let isGroup = c.messages.map { $0.matches(role: n.role, title: { n.effectiveTitle }, childRoles: { n.children.map(\.role) }) } ?? false
        // The group's own label ("Chat messages") is structure; what is inside it is content.
        var out = n
        out.title = n.title.map { text($0, inMessages, c, &stats) }
        out.value = n.value.map { text($0, inMessages, c, &stats) }
        out.description = n.description.map { text($0, inMessages, c, &stats) }
        out.identifier = n.identifier.map { id in
            if id.isEmpty { return id }
            if c.policy.identifiers.contains(id), !c.chatNames.contains(id) { stats.kept += 1; return id }
            stats.hashed += 1
            return hash(id, salt: c.salt)
        }
        out.children = []
        return (out, inMessages || isGroup)
    }

    private static func text(_ s: String, _ inMessages: Bool, _ c: Context, _ stats: inout RedactStats) -> String {
        if s.isEmpty { return s }
        if inMessages { stats.dropped += 1; return droppedMarker }
        if c.chatNames.contains(s) { stats.hashed += 1; return hash(s, salt: c.salt) }
        if c.policy.allowlist.contains(s) { stats.kept += 1; return s }
        if let t = composerTitle(s, c) { stats.kept += 1; return t }
        stats.hashed += 1
        return hash(s, salt: c.salt)
    }

    /// "Message in <name> Attach file ... Send": the chat name is hashed; the rest stays when every word is a known UI
    /// word, else the rest is hashed as a whole. The main chat composer has no name and stays whole under the same rule.
    private static func composerTitle(_ s: String, _ c: Context) -> String? {
        func known(_ rest: String) -> Bool { rest.split(separator: " ").allSatisfy { c.policy.vocabulary.contains(String($0)) } }
        if let name = ChatNames.chatFromComposerTitle(s, rules: c.composer), let r = s.range(of: c.composer.named.terminator) {
            let rest = String(s[r.upperBound...])
            let tail = known(rest) ? rest : (rest.isEmpty ? "" : " " + hash(rest, salt: c.salt))
            return c.composer.named.prefix + hash(name, salt: c.salt) + c.composer.named.terminator + tail
        }
        if c.composer.unnamedTitle.matches(s), known(s) { return s }
        return nil
    }
}
