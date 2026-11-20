import Foundation

/// A dotted numeric version such as "13.1" or "13.1.2". Trailing zeros are insignificant.
public struct Version: Comparable, Equatable {
    let parts: [Int]

    public init?(_ s: String) {
        let pieces = s.split(separator: ".", omittingEmptySubsequences: false)
        guard !pieces.isEmpty else { return nil }
        var out: [Int] = []
        for p in pieces {
            guard !p.isEmpty, p.allSatisfy(\.isASCII), p.allSatisfy(\.isNumber), let n = Int(p) else { return nil }
            out.append(n)
        }
        var trimmed = out
        while trimmed.count > 1, trimmed.last == 0 { trimmed.removeLast() }
        parts = trimmed
    }

    public static func < (a: Version, b: Version) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) {
            let x = i < a.parts.count ? a.parts[i] : 0, y = i < b.parts.count ? b.parts[i] : 0
            if x != y { return x < y }
        }
        return false
    }
}

/// Version specs used in rules: a bare version ("12.1", exact) or space-separated comparators that must
/// all hold (">=13.1 <14"). Operators: >=, <=, >, <, =.
public enum VersionSpec {
    typealias Comparator = (op: String, version: Version)

    static func parse(_ spec: String) -> [Comparator]? {
        let tokens = spec.split(separator: " ").map(String.init)
        guard !tokens.isEmpty else { return nil }
        var out: [Comparator] = []
        for t in tokens {
            let op = [">=", "<=", ">", "<", "="].first { t.hasPrefix($0) } ?? "="
            guard let v = Version(op == "=" && !t.hasPrefix("=") ? t : String(t.dropFirst(op.count))) else { return nil }
            out.append((op, v))
        }
        return out
    }

    public static func isValid(_ spec: String) -> Bool { parse(spec) != nil }

    public static func matches(_ spec: String, version: String) -> Bool {
        guard let comps = parse(spec), let v = Version(version) else { return false }
        return comps.allSatisfy { c in
            switch c.op {
            case ">=": return v >= c.version
            case "<=": return v <= c.version
            case ">": return v > c.version
            case "<": return v < c.version
            default: return v == c.version
            }
        }
    }

    /// Lowest version a spec can match; orders profiles from oldest to newest.
    public static func lowerBound(_ spec: String) -> Version? {
        guard let comps = parse(spec) else { return nil }
        let lows = comps.filter { [">=", ">", "="].contains($0.op) }.map(\.version)
        return lows.max() ?? Version("0")
    }
}
