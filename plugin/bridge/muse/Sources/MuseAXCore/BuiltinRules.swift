import Foundation

/// The rules compiled into the binary (profiles for the Muse versions verified live). The JSON text lives in
/// BuiltinRulesData.swift, generated from rules/muse.json by plugin/scripts/sync-builtin-rules.sh.
public enum BuiltinRules {
    public static var json: String { BuiltinRulesData.json }

    public static let document: RulesDocument = {
        let data = Data(BuiltinRulesData.json.utf8)
        do { return try RulesDocument.decode(bot: RulesDocument.peekBot(data) ?? "", data) } catch {
            fatalError("built-in rules are invalid (run plugin/scripts/sync-builtin-rules.sh): \(error)")
        }
    }()
}
