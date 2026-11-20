import Testing
import Foundation
@testable import MuseAXCore

@Suite struct DoctorReportTests {
    let h = Hierarchy()
    func facts(running: Bool = true, anchors: [(String, Bool)]? = nil, keyset: KeysetState? = nil, lock: LockInfo = .free,
               sends: [[String: Any]] = []) -> DoctorFacts {
        var app = AppDiagnostics.notRunning
        if running {
            app = AppDiagnostics(running: true, axTrusted: true, versionShort: "13.1", versionBuild: "1342", layout: "chat_switcher",
                                 anchors: anchors ?? [("window", true), ("chat_list", true), ("composer", true)], windowWidth: 614, windowHeight: 658,
                                 profile: "muse-13.1", versionCheck: "verified", rulesSource: "cache", rulesRevision: 2, rulesKeyId: "rules-1",
                                 rulesNote: nil, verifiedVersions: ["12.1", ">=13.1 <13.2"])
        }
        return DoctorFacts(bot: "muse", binaryVersion: "0.1.0", app: app, rulesChannel: "stable", keyset: keyset ?? h.ctx.keyset, lock: lock, sends: sends)
    }

    @Test func theReportCarriesEveryFactTheMaintainerAsksFor() {
        let f = DoctorReport.fields(facts())
        let app = f["app"] as! [String: Any], rules = f["rules"] as! [String: Any], ks = f["keyset"] as! [String: Any]
        #expect(app["version"] as? String == "13.1" && app["build"] as? String == "1342" && app["layout"] as? String == "chat_switcher")
        #expect((app["window"] as! [String: Int]) == ["width": 614, "height": 658])
        #expect((app["anchors"] as! [String: Bool])["composer"] == true && app["profile"] as? String == "muse-13.1")
        #expect(rules["source"] as? String == "cache" && rules["revision"] as? Int == 2 && rules["key_id"] as? String == "rules-1" && rules["channel"] as? String == "stable")
        #expect(ks["state"] as? String == "valid" && (ks["keys"] as! [[String: Any]]).map { $0["id"] as! String } == ["rules-1", "binary-1"])
        #expect(f["binary_version"] as? String == "0.1.0" && f["bot"] as? String == "muse")
        #expect((f["lock"] as! [String: Any])["held"] as? Bool == false)
    }
    @Test func theTextReportIsPasteReadyAndMarksMissingAnchors() {
        let t = DoctorReport.text(facts(anchors: [("window", true), ("composer", false)]))
        #expect(t.contains("version 13.1 (build 1342)") && t.contains("614x658") && t.contains("MISSING composer") && t.contains("ok window"))
        #expect(t.contains("key_id rules-1") && t.contains("keyset valid") && t.contains("binary 0.1.0"))
        #expect(!t.contains("\u{1B}"))
    }
    @Test func aHiddenChatListIsInformationNotAFailure() {
        let f = facts(anchors: [("window", true), ("chat_list", false), ("composer", true)])
        #expect((DoctorReport.fields(f)["app"] as! [String: Any])["failed_anchors"] as? [String] == [])
        let t = DoctorReport.text(f)
        #expect(t.contains("not shown chat_list") && !t.contains("MISSING chat_list"))
    }
    @Test func aStoppedAppStillProducesAReport() {
        let f = DoctorReport.fields(facts(running: false, keyset: .absent))
        #expect((f["app"] as! [String: Any])["running"] as? Bool == false)
        #expect((f["keyset"] as! [String: Any])["state"] as? String == "absent")
        #expect(DoctorReport.text(facts(running: false, keyset: .absent)).contains("not running"))
    }
    @Test func theKeysetStatesAreDescribedIncludingTheReason() {
        let inv = DoctorReport.fields(facts(keyset: .invalid("bad_signature")))["keyset"] as! [String: Any]
        #expect(inv["state"] as? String == "invalid" && inv["reason"] as? String == "bad_signature")
        let exp = DoctorReport.fields(facts(keyset: .expired(h.keyset)))["keyset"] as! [String: Any]
        #expect(exp["state"] as? String == "expired" && exp["not_after"] is String)
        let rev = try! Keyset.decode(h.bytes(h.keysetObject(revoked: ["rules-1"])))
        #expect(((DoctorReport.fields(facts(keyset: .valid(rev, source: "bundled")))["keyset"] as! [String: Any])["revoked"] as? Int) == 1)
        #expect(DoctorReport.text(facts(keyset: .expired(h.keyset))).contains("keyset expired"))
        #expect(DoctorReport.text(facts(keyset: .absent)).contains("no signed update is trusted"))
    }
    @Test func lockStateIsReported() {
        let held = DoctorReport.fields(facts(lock: LockInfo(held: true, pid: 4242, alive: true, ageSeconds: 7)))["lock"] as! [String: Any]
        #expect(held["held"] as? Bool == true && held["pid"] as? Int == 4242 && held["alive"] as? Bool == true && held["age_seconds"] as? Int == 7)
        #expect(DoctorReport.text(facts(lock: LockInfo(held: true, pid: 4242, alive: false, ageSeconds: 900))).contains("pid 4242 (gone)"))
    }
    @Test func onlyTheTimeAndOutcomeOfTheLastFiveSendsAreShownNeverTheChat() {
        let rows = (1...8).map { ["at": "2026-11-0\($0)T10:00:00Z", "chat": "Project Phoenix", "sha256": "ab", "length": 9, "outcome": $0 % 2 == 0 ? "sent" : "user_active"] as [String: Any] }
        let f = DoctorReport.fields(facts(sends: rows))
        let last = f["last_sends"] as! [[String: String]]
        #expect(last.count == 5 && last.first?["at"] == "2026-11-04T10:00:00Z" && last.last?["outcome"] == "sent")
        #expect(last.allSatisfy { Set($0.keys) == ["at", "outcome"] })
        #expect(!DoctorReport.text(facts(sends: rows)).contains("Phoenix"))
        #expect(!(JSONOut.line(f)).contains("Phoenix"))
    }
}

@Suite struct LockInspectTests {
    @Test func aFreeLockReportsNotHeld() { #expect(UILock.state(home: Fx.tempDir()) == .free) }
    @Test func aHeldLockReportsItsOwnerAndAge() throws {
        let home = Fx.tempDir()
        let lock = try #require(FileLock.acquire(at: UILock.path(home: home)))
        defer { lock.release() }
        let s = UILock.state(home: home)
        #expect(s.held && s.pid == getpid() && s.alive == true && (s.ageSeconds ?? 99) < 5)
    }
    @Test func aDeadOwnersLockIsShownAsGone() throws {
        let home = Fx.tempDir()
        try "999999\nnonce\n".write(to: UILock.path(home: home), atomically: true, encoding: .utf8)
        let s = UILock.state(home: home)
        #expect(s.held && s.pid == 999999 && s.alive == false)
    }
}

@Suite struct DraftProfileTests {
    @Test func aDraftCopiesTheClosestProfileForTheNewVersion() {
        let raw = T.switcherTree()
        let red = Redactor.redact(raw, profile: Fx.p13, salt: "s").tree
        let d = DraftProfile.make(raw: raw, redacted: red, base: Fx.p13, idPrefix: "muse", version: "13.2")
        #expect(d.profile["id"] as? String == "muse-13.2-draft")
        #expect(((d.profile["match"] as! [String: Any])["versions"] as! [String]) == ["13.2"])
        #expect((d.profile["elements"] as! [String: Any]).count == Fx.p13.elements.count)
        #expect(d.notes.first?.contains("muse-13.1") == true)
        #expect(d.notes.count == 1, "nothing is missing, so only the standing note")
    }
    @Test func anElementThatMatchesNothingGetsCandidatesFromTheRedactedTree() {
        var raw = T.switcherTree()
        raw.children[0].children[0].children[2].title = "Compose a message for Project Phoenix"
        let red = Redactor.redact(raw, profile: Fx.p13, salt: "s").tree
        let d = DraftProfile.make(raw: raw, redacted: red, base: Fx.p13, idPrefix: "muse", version: "14.0")
        let note = d.notes.first { $0.hasPrefix("composer:") }
        #expect(note != nil && note!.contains("AXButton"))
        #expect(!d.notes.joined().contains("Phoenix"))
        #expect(!JSONOut.line(d.profile).contains("Phoenix"))
    }
    @Test func aMissingVersionIsAPlaceholderTheMaintainerMustFill() {
        let raw = T.switcherTree()
        let d = DraftProfile.make(raw: raw, redacted: raw, base: Fx.p13, idPrefix: "muse", version: nil)
        #expect(((d.profile["match"] as! [String: Any])["versions"] as! [String]) == ["SET-THE-VERSION"])
    }
}
