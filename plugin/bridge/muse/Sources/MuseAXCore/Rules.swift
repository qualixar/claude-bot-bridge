import Foundation

/// How a title string must look. Every given condition must hold.
public struct TitleMatcher: Codable, Equatable {
    public var equals: String?
    public var prefix: String?
    public var suffix: String?
    public var contains: String?
    public var nonEmpty: Bool?
    public var notIn: [String]?

    public init(equals: String? = nil, prefix: String? = nil, suffix: String? = nil, contains: String? = nil,
                nonEmpty: Bool? = nil, notIn: [String]? = nil) {
        self.equals = equals; self.prefix = prefix; self.suffix = suffix; self.contains = contains
        self.nonEmpty = nonEmpty; self.notIn = notIn
    }

    public func matches(_ t: String) -> Bool {
        if let e = equals, t != e { return false }
        if let p = prefix, !t.hasPrefix(p) { return false }
        if let s = suffix, !t.hasSuffix(s) { return false }
        if let c = contains, !t.contains(c) { return false }
        if nonEmpty == true, t.isEmpty { return false }
        if let n = notIn, n.contains(t) { return false }
        return true
    }
}

/// An accessibility element, described by role, title and (optionally) the roles of its direct children.
public struct ElementMatcher: Codable, Equatable {
    public var role: String?
    public var title: TitleMatcher?
    public var childRole: String?

    public init(role: String? = nil, title: TitleMatcher? = nil, childRole: String? = nil) {
        self.role = role; self.title = title; self.childRole = childRole
    }

    /// True when matching needs the child roles (they cost an accessibility call each).
    public var needsChildren: Bool { childRole != nil }

    /// `title` and `childRoles` are closures because each costs an accessibility call; they run only when needed.
    public func matches(role r: String, title: () -> String, childRoles: () -> [String]) -> Bool {
        if let want = role, r != want { return false }
        if let m = self.title, !m.matches(title()) { return false }
        if let c = childRole, !childRoles().contains(c) { return false }
        return true
    }

    public func matches(role r: String, title t: String, childRoles: () -> [String]) -> Bool {
        matches(role: r, title: { t }, childRoles: childRoles)
    }
}

public struct LayoutSignal: Codable, Equatable {
    public var layout: String
    public var element: String
}

public struct LayoutRules: Codable, Equatable {
    /// First signal whose element is found decides the layout.
    public var detect: [LayoutSignal]
    /// Extra element anchors each layout needs on top of `anchors.required`.
    public var extraAnchors: [String: [String]]
}

public struct AnchorRules: Codable, Equatable {
    /// Elements that must be found for the profile to be usable.
    public var required: [String]
    /// Anchor name -> element that must be absent (a transient state, e.g. an open sheet).
    public var absent: [String: String]
}

public struct ComposerNamed: Codable, Equatable {
    public var prefix: String
    public var terminator: String
}

public struct ComposerRules: Codable, Equatable {
    public var idleSuffix: String
    public var named: ComposerNamed
    public var unnamedTitle: TitleMatcher
    public var mainChatName: String
}

public struct MessageRules: Codable, Equatable {
    public var userPrefixes: [String]
    public var userMarkers: [String]
    public var assistantPrefixes: [String]
    public var timePattern: String
}

public struct ProfileMatch: Codable, Equatable {
    public var versions: [String]
}

/// Everything the bridge knows about one generation of the Muse UI.
public struct Profile: Codable, Equatable {
    public var id: String
    public var match: ProfileMatch
    public var elements: [String: ElementMatcher]
    public var layout: LayoutRules
    public var anchors: AnchorRules
    public var composer: ComposerRules
    public var messages: MessageRules
    /// Whole UI strings that are fixed parts of the app, not user data (button names, the composer's words). Used by
    /// `muse-ax doctor --dump-tree` as the allowlist of text that may stay readable in a shared tree. Optional.
    public var labels: [String]?
    /// AXIdentifier values that are fixed parts of the page (DOM ids of structural containers), not user data. Optional. The
    /// redactor of `doctor --dump-tree` keeps exactly these readable and hashes every other identifier.
    public var structuralIdentifiers: [String]?

    enum CodingKeys: String, CodingKey {
        case id, match, elements, layout, anchors, composer, messages, labels
        case structuralIdentifiers = "structural_identifiers"
    }

    public func matches(version: String) -> Bool { match.versions.contains { VersionSpec.matches($0, version: version) } }

    /// Position on the old-to-new axis: the highest version any of the match specs starts at.
    public var sortKey: Version { match.versions.compactMap(VersionSpec.lowerBound).max() ?? Version("0")! }

    public func detectLayout(found: (String) -> Bool) -> ChatListLayout {
        for s in layout.detect where found(s.element) {
            return ChatListLayout(rawValue: s.layout) ?? .unknown
        }
        return .unknown
    }

    /// Element names that must exist for this layout (excludes transient anchors).
    public func requiredElements(layout l: ChatListLayout) -> [String] {
        anchors.required + (layout.extraAnchors[l.rawValue] ?? [])
    }
}

/// A signed rules document. Unknown JSON keys are ignored so additive changes stay readable.
public struct RulesDocument: Codable, Equatable {
    public static let supportedSchema = 1
    public var schema: Int
    public var bot: String
    public var revision: Int
    public var profiles: [Profile]
    /// The keyset key (use "rules") that signed this document. Inside the signed bytes, so it cannot be swapped.
    public var keyId: String?
    /// ISO 8601 UTC time after which these rules are ignored (the built-in rules are used instead). Optional.
    public var notAfter: String?

    enum CodingKeys: String, CodingKey {
        case schema, bot, revision, profiles
        case keyId = "key_id"
        case notAfter = "not_after"
    }

    public init(schema: Int, bot: String, revision: Int, profiles: [Profile], keyId: String? = nil, notAfter: String? = nil) {
        self.schema = schema; self.bot = bot; self.revision = revision; self.profiles = profiles
        self.keyId = keyId; self.notAfter = notAfter
    }

    /// When these rules stop being used; nil when there is no `not_after`.
    public var expiry: Date? { notAfter.flatMap { ISO8601DateFormatter().date(from: $0) } }
    public func isExpired(at now: Date) -> Bool { expiry.map { now > $0 } ?? false }
}
