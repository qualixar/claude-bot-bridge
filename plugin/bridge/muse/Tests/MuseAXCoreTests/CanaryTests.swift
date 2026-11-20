import Testing
import Foundation
@testable import MuseAXCore

@Suite struct CanaryTests {
    @Test func decisions() {
        #expect(Canary.decide(lastSeen: "13.1", current: "13.1") == .unchanged)
        #expect(Canary.decide(lastSeen: nil, current: "13.1") == .firstRun)
        #expect(Canary.decide(lastSeen: "13.1", current: "13.2") == .changed(from: "13.1"))
    }
    @Test func notificationTexts() {
        #expect(Canary.notification(version: "13.2", ok: true) == "Muse updated to 13.2: bridge OK")
        #expect(Canary.notification(version: "13.2", ok: false) == "Muse 13.2 changed its layout: tasks will go through the board until rules update")
    }
    @Test func notTrustedNotification() {
        #expect(Canary.notTrustedNotification(version: "13.2").contains("Accessibility") && Canary.notTrustedNotification(version: "13.2").contains("13.2"))
    }
    @Test func versionsAreSanitisedForTheShell() {
        #expect(Canary.notification(version: "1\"; do shell script \"x", ok: true) == "Muse updated to 1doshellscriptx: bridge OK")
    }
    @Test func appleScriptArguments() {
        let a = Canary.osascriptArguments(text: "Muse updated to 13.2: bridge OK")
        #expect(a == ["-e", #"display notification "Muse updated to 13.2: bridge OK" with title "Claude Bot Bridge""#])
        #expect(Canary.osascriptArguments(text: #"a"b\c"#)[1].contains(#"a\"b\\c"#))
    }
}

@Suite struct BridgeInfoTests {
    @Test func versionMatchesPluginJson() throws {
        let url = Fx.repoFile("plugin/.claude-plugin/plugin.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let o = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        #expect(o["version"] as? String == BridgeInfo.version)
    }
    @Test func versionIsDotted() { #expect(Version(BridgeInfo.version) != nil) }
}

@Suite struct UiUnavailableTests {
    @Test func codeMessageAndDetails() {
        let e = MuseError.uiUnavailable(version: "14.0", failed: ["composer", "chat_messages_group"])
        #expect(e.code == "ui_unavailable")
        #expect(e.message.contains("14.0") && e.message.contains("composer") && e.message.contains("board"))
        let s = JSONOut.failure(e)
        #expect(s.contains("\"muse_version\":\"14.0\"") && s.contains("\"failed_anchors\":[\"composer\",\"chat_messages_group\"]"))
        #expect(JSONOut.failure(.sheetOpen).contains("details") == false)
    }
    @Test func unknownVersionWording() {
        #expect(MuseError.uiUnavailable(version: nil, failed: ["composer"]).message.contains("unknown"))
    }
}
