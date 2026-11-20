import Foundation

public enum RulesError: Error, Equatable {
    case notJSON(String)
    case schemaUnsupported(Int)
    case invalid(String)
}

extension RulesDocument {
    /// The `schema` number of a document, even when the rest of it is a shape this build cannot read.
    public static func peekSchema(_ data: Data) -> Int? {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["schema"] as? Int
    }

    /// The `bot` a document declares, even when the rest of it is a shape this build cannot read.
    public static func peekBot(_ data: Data) -> String? {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["bot"] as? String
    }

    /// The `key_id` of a document, even when the rest of it is a shape this build cannot read.
    public static func peekKeyId(_ data: Data) -> String? {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["key_id"] as? String
    }

    /// A bot id is a short lowercase name; it names the rules file (`<bot>.json`) and the driver that reads it.
    public static func isValidBotID(_ s: String) -> Bool { s.range(of: "^[a-z][a-z0-9_-]{0,31}$", options: .regularExpression) != nil }

    /// Decodes and validates for the bot `bot` (the driver's rules namespace). A newer schema is reported as
    /// `.schemaUnsupported` before any shape is assumed.
    public static func decode(bot: String, _ data: Data) throws -> RulesDocument {
        guard let schema = peekSchema(data) else { throw RulesError.notJSON("missing or unreadable \"schema\"") }
        guard schema == supportedSchema else { throw RulesError.schemaUnsupported(schema) }
        let doc: RulesDocument
        do { doc = try JSONDecoder().decode(RulesDocument.self, from: data) } catch {
            throw RulesError.invalid("shape: \(error.localizedDescription)")
        }
        try doc.validate(bot: bot)
        return doc
    }

    /// Elements the code cannot work without; the rest degrade to "not found".
    static let coreElements = ["web_area", "chat_messages_group", "composer", "sheet", "static_text"]

    func validate(bot expected: String) throws {
        guard RulesDocument.isValidBotID(expected), bot == expected else { throw RulesError.invalid("bot must be \"\(expected)\"") }
        if let n = notAfter, ISO8601DateFormatter().date(from: n) == nil { throw RulesError.invalid("not_after must be an ISO 8601 UTC time") }
        guard revision >= 1 else { throw RulesError.invalid("revision must be >= 1") }
        guard !profiles.isEmpty else { throw RulesError.invalid("no profiles") }
        guard Set(profiles.map(\.id)).count == profiles.count else { throw RulesError.invalid("duplicate profile id") }
        for p in profiles { try p.validate() }
    }
}

extension Profile {
    func validate() throws {
        func bad(_ m: String) -> RulesError { .invalid("profile \(id): \(m)") }
        guard !id.isEmpty else { throw RulesError.invalid("empty profile id") }
        guard !match.versions.isEmpty, match.versions.allSatisfy(VersionSpec.isValid) else { throw bad("invalid version spec") }
        for name in RulesDocument.coreElements where elements[name] == nil { throw bad("missing element \(name)") }
        let refs = anchors.required + Array(anchors.absent.values) + layout.detect.map(\.element) + layout.extraAnchors.values.flatMap { $0 }
        if let missing = refs.first(where: { elements[$0] == nil }) { throw bad("unknown element \(missing)") }
        let layouts = [ChatListLayout.sidebar.rawValue, ChatListLayout.chatSwitcher.rawValue]
        if let l = layout.detect.map(\.layout).first(where: { !layouts.contains($0) }) { throw bad("unknown layout \(l)") }
        guard (try? NSRegularExpression(pattern: messages.timePattern)) != nil else { throw bad("timePattern is not a valid regex") }
    }
}
