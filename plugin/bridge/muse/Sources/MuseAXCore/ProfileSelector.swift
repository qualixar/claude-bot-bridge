import Foundation

public enum SelectionKind: String, Equatable {
    /// The Muse version is listed in a profile.
    case matched
    /// The version is unlisted, but a profile's anchors are all present in the live UI.
    case probe
    /// No profile fits.
    case none
}

public struct ProfileSelection {
    public let kind: SelectionKind
    /// The chosen profile; for `.none` the closest candidate (fewest missing anchors), kept for diagnostics.
    public let profile: Profile
    public let failedAnchors: [String]

    public init(kind: SelectionKind, profile: Profile, failedAnchors: [String]) {
        self.kind = kind; self.profile = profile; self.failedAnchors = failedAnchors
    }

    /// Value of `version_check` in the JSON output.
    public func versionCheck(version: String?) -> String {
        switch kind {
        case .matched: return "verified"
        case .probe: return "probe"
        case .none: return version == nil ? "unknown" : "unverified"
        }
    }
}

public enum ProfileSelector {
    /// Version match first, then probe mode: the newest profile whose required anchors are all found.
    /// `probe` returns (anchor name, found) for one profile and is only called when needed.
    /// With `verifyMatched`, a version-matched profile must also pass the probe (used before typing).
    public static func select(version: String?, profiles: [Profile], verifyMatched: Bool = false,
                              probe: (Profile) -> [(String, Bool)]) -> ProfileSelection? {
        let newestFirst = profiles.enumerated()
            .sorted { ($0.element.sortKey, $0.offset) > ($1.element.sortKey, $1.offset) }.map(\.element)
        guard !newestFirst.isEmpty else { return nil }
        let matched = version.map { v in newestFirst.filter { $0.matches(version: v) } } ?? []
        var best: ProfileSelection?
        if let m = matched.first {
            if !verifyMatched { return ProfileSelection(kind: .matched, profile: m, failedAnchors: []) }
            for p in matched {
                let failed = missing(probe(p))
                if failed.isEmpty { return ProfileSelection(kind: .matched, profile: p, failedAnchors: []) }
                best = closer(best, ProfileSelection(kind: .none, profile: p, failedAnchors: failed))
            }
        }
        for p in newestFirst where !matched.contains(where: { $0.id == p.id }) {
            let failed = missing(probe(p))
            if failed.isEmpty { return ProfileSelection(kind: .probe, profile: p, failedAnchors: []) }
            best = closer(best, ProfileSelection(kind: .none, profile: p, failedAnchors: failed))
        }
        return best
    }

    static func missing(_ results: [(String, Bool)]) -> [String] { results.filter { !$0.1 }.map { $0.0 } }

    /// Fewer failures win; on a tie the earlier (newer) candidate stays.
    static func closer(_ a: ProfileSelection?, _ b: ProfileSelection) -> ProfileSelection {
        guard let a = a else { return b }
        return b.failedAnchors.count < a.failedAnchors.count ? b : a
    }
}
