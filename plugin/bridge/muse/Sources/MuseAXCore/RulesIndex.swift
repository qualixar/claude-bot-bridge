import Foundation

/// `rules/index.json`: which bots have rules in this repository and in which file. Signed like the rules
/// (key_id of a `rules` key, detached `.sig`). The updater reads it to find the rules file of the driver it runs;
/// a bot that is not listed is not updated.
public struct RulesIndex: Equatable {
    public struct Entry: Equatable { public let id: String; public let rules: String }
    public static let supportedSchema = 1
    public let schema: Int
    public let revision: Int
    public let keyId: String?
    public let bots: [Entry]

    public func entry(for bot: String) -> Entry? { bots.first { $0.id == bot } }

    public static func decode(_ data: Data) throws -> RulesIndex {
        guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let schema = o["schema"] as? Int else {
            throw RulesError.notJSON("missing or unreadable \"schema\"")
        }
        guard schema == supportedSchema else { throw RulesError.schemaUnsupported(schema) }
        guard let revision = o["revision"] as? Int, revision >= 1 else { throw RulesError.invalid("revision must be >= 1") }
        guard let raw = o["bots"] as? [[String: Any]], !raw.isEmpty else { throw RulesError.invalid("bots must be a non-empty list") }
        let bots = try raw.map { b -> Entry in
            guard let id = b["id"] as? String, RulesDocument.isValidBotID(id) else { throw RulesError.invalid("a bot id must be a short lowercase name") }
            // A plain file name next to the index: no directories, no traversal.
            guard let file = b["rules"] as? String, file.range(of: "^[A-Za-z0-9._-]+\\.json$", options: .regularExpression) != nil, !file.contains("..") else {
                throw RulesError.invalid("bot \(id): rules must be a plain .json file name")
            }
            return Entry(id: id, rules: file)
        }
        guard Set(bots.map(\.id)).count == bots.count else { throw RulesError.invalid("duplicate bot id") }
        return RulesIndex(schema: schema, revision: revision, keyId: o["key_id"] as? String, bots: bots)
    }
}
