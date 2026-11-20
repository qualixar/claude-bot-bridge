import Testing
@testable import MuseAXCore

@Suite struct VerifyNormalizeTests {
    @Test func toleratesSmartQuotesAndLineBreaks() {
        let shown = "[Claude Code] named \u{201C}Board\u{201D} at\nhttps://x.dev/mcp\n. done"
        let msgs = [Message(role: "user", text: shown)]
        #expect(MessageParser.lastUserContains("[Claude Code] named \"Board\" at https://x.dev/mcp. done", in: msgs))
    }

    @Test func stillRejectsDifferentText() {
        let msgs = [Message(role: "user", text: "[Claude Code] ping")]
        #expect(!MessageParser.lastUserContains("[Claude Code] something else", in: msgs))
    }
}
