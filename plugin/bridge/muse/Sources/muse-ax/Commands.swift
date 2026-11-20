import Foundation
import MuseAXCore

/// The drivers this binary contains. Muse is the only one.
enum Bots {
    static let registry = BotRegistry([MuseDriver()], defaultID: MuseDriver.id)
}

/// Each command returns the JSON fields for a successful result or throws MuseError. Bot-specific work goes through
/// the `BotDriver` chosen by CBB_BOT (default: Muse); everything else here is bot-independent.
enum Commands {
    static func run(_ c: Command) throws -> [String: Any] {
        let bot = try Bots.registry.resolve()
        switch c {
        case .status: return bot.status()
        case .chats: return try bot.chats()
        case .open(let n): return try bot.open(chat: n)
        case .newSideChat: return try bot.newSideChat()
        case .read(let chat, let last): return try bot.read(chat: chat, last: last)
        case .send(let chat, let text, let dry): return try bot.send(chat: chat, text: text, dryRun: dry)
        case .history(let last): return ["sends": SendJournal.read(home: RulesStore.home(), last: last), "path": SendJournal.path(home: RulesStore.home()).path]
        case .waitReply(let chat, let t): return try bot.waitReply(chat: chat, timeout: t)
        case .selftest: return try bot.selftest()
        case .version: return ["name": "muse-ax", "version": BridgeInfo.version]
        case .rulesUpdate: return RulesCommands.update(bot: bot)
        case .rulesShow: return RulesCommands.show(bot: bot)
        case .canary(let notify): return try CanaryRunner.run(bot: bot, notify: notify)
        case .doctor(let dump, _): return try DoctorCommand.run(bot: bot, dump: dump)
        }
    }

    /// Runs `body` while holding the cross-process UI lock (waits up to 10 s, then fails `busy`).
    static func locked<T>(_ body: () throws -> T) throws -> T { try UILock.withLock(home: RulesStore.home(), body) }
}
