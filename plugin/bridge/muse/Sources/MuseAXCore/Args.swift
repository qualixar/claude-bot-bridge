import Foundation

public enum Command: Equatable {
    case status
    case chats
    case open(name: String)
    case newSideChat
    case read(chat: String?, last: Int?)
    case send(chat: String, text: String, dryRun: Bool)
    case history(last: Int?)
    case waitReply(chat: String, timeout: Double)
    case selftest
    case version
    case rulesUpdate
    case rulesShow
    case canary(notify: Bool)
    case doctor(dump: DumpTarget?, text: Bool)
}

/// Where `doctor --dump-tree` writes: an explicit path, or the default folder under the bridge home.
public enum DumpTarget: Equatable {
    case defaultPath
    case path(String)
}

public enum ArgParser {
    public static let usage = "usage: muse-ax status|chats|open <name>|new-side-chat|read [--chat n] [--last N]|send [--dry-run] --chat n <text>|history [--last N]|wait-reply --chat n [--timeout s]|selftest|version|rules update|rules show|canary [--no-notify]|doctor [--text] [--dump-tree [path]]"

    public static func parse(_ args: [String]) throws -> Command {
        guard let cmd = args.first else { throw MuseError.invalidArgument(usage) }
        var rest = Array(args.dropFirst())
        switch cmd {
        case "status": try noExtra(rest); return .status
        case "chats": try noExtra(rest); return .chats
        case "selftest": try noExtra(rest); return .selftest
        case "version": try noExtra(rest); return .version
        case "rules":
            guard rest.count == 1, ["update", "show"].contains(rest[0]) else { throw MuseError.invalidArgument("usage: muse-ax rules update|show") }
            return rest[0] == "update" ? .rulesUpdate : .rulesShow
        case "canary":
            let quiet = rest.contains("--no-notify")
            try noExtra(rest.filter { $0 != "--no-notify" })
            return .canary(notify: !quiet)
        case "doctor": return try parseDoctor(rest)
        case "new-side-chat": try noExtra(rest); return .newSideChat
        case "open":
            guard rest.count == 1, !rest[0].isEmpty else { throw MuseError.invalidArgument("open requires exactly one <name>") }
            return .open(name: rest[0])
        case "read":
            let chat = try take("--chat", &rest)
            let last = try take("--last", &rest).map(parseInt("--last"))
            try noExtra(rest)
            if let l = last, l < 1 { throw MuseError.invalidArgument("--last must be >= 1") }
            return .read(chat: chat, last: last)
        case "history":
            let last = try take("--last", &rest).map(parseInt("--last"))
            try noExtra(rest)
            if let l = last, l < 1 { throw MuseError.invalidArgument("--last must be >= 1") }
            return .history(last: last)
        case "send":
            let dryRun = rest.contains("--dry-run")
            rest.removeAll { $0 == "--dry-run" }
            guard let chat = try take("--chat", &rest) else { throw MuseError.invalidArgument("send requires --chat <name>") }
            guard rest.count == 1 else { throw MuseError.invalidArgument("send requires exactly one <text> argument") }
            return .send(chat: chat, text: rest[0], dryRun: dryRun)
        case "wait-reply":
            guard let chat = try take("--chat", &rest) else { throw MuseError.invalidArgument("wait-reply requires --chat <name>") }
            let t = try take("--timeout", &rest).map(parseDouble("--timeout")) ?? 120
            try noExtra(rest)
            guard t > 0, t <= 3600 else { throw MuseError.invalidArgument("--timeout must be in (0, 3600] seconds") }
            return .waitReply(chat: chat, timeout: t)
        default: throw MuseError.invalidArgument("unknown command \"\(cmd)\". \(usage)")
        }
    }

    /// `doctor [--text] [--dump-tree [path]]`: the path is optional; a following flag is not a path.
    static func parseDoctor(_ args: [String]) throws -> Command {
        var text = false
        var dump: DumpTarget?
        var i = 0
        while i < args.count {
            switch args[i] {
            case "--text": text = true
            case "--dump-tree":
                guard dump == nil else { throw MuseError.invalidArgument("--dump-tree was given twice") }
                if i + 1 < args.count, !args[i + 1].hasPrefix("-") {
                    guard !args[i + 1].isEmpty else { throw MuseError.invalidArgument("--dump-tree needs a path or nothing") }
                    dump = .path(args[i + 1]); i += 1
                } else { dump = .defaultPath }
            default: throw MuseError.invalidArgument("unexpected arguments: \(args[i]). usage: muse-ax doctor [--text] [--dump-tree [path]]")
            }
            i += 1
        }
        return .doctor(dump: dump, text: text)
    }

    static func noExtra(_ rest: [String]) throws {
        if !rest.isEmpty { throw MuseError.invalidArgument("unexpected arguments: \(rest.joined(separator: " "))") }
    }

    /// Removes `flag value` from args and returns the value.
    static func take(_ flag: String, _ args: inout [String]) throws -> String? {
        guard let i = args.firstIndex(of: flag) else { return nil }
        guard i + 1 < args.count else { throw MuseError.invalidArgument("\(flag) needs a value") }
        let v = args[i + 1]
        args.removeSubrange(i...(i + 1))
        return v
    }

    static func parseInt(_ flag: String) -> (String) throws -> Int {
        { s in guard let v = Int(s) else { throw MuseError.invalidArgument("\(flag) must be an integer") }; return v }
    }
    static func parseDouble(_ flag: String) -> (String) throws -> Double {
        { s in guard let v = Double(s) else { throw MuseError.invalidArgument("\(flag) must be a number") }; return v }
    }
}
