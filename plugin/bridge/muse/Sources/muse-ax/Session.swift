import Foundation
import AppKit
import MuseAXCore

/// A connected Muse app plus the rules and profile used to read it.
struct MuseSession {
    let muse: MuseApp
    let rules: LoadedRules
    let selection: ProfileSelection
    let version: (short: String?, build: String?)

    var versionCheck: String { selection.versionCheck(version: version.short) }

    /// Connects, loads rules, picks a profile. `forSending` also requires the matched profile's anchors to
    /// be present in the live tree (otherwise probe mode decides), because typing into a changed UI is the
    /// one thing the bridge must not do blindly.
    static func open(forSending: Bool = false) throws -> MuseSession {
        let driver = MuseDriver()
        let rules = RulesStore.load(home: RulesStore.home(), bot: driver.rulesNamespace, trust: LiveTrust.context(), builtin: driver.builtinRules)
        guard let first = rules.document.profiles.first else { throw MuseError.anchorMissing("rules") }
        let base = try MuseApp.connect(profile: first)
        if forSending && base.window == nil { throw MuseError.composerNotFound }
        let ver = MuseSession.version(of: base.app)
        guard let sel = driver.selectProfile(version: ver.short, profiles: rules.document.profiles, verifyMatched: forSending,
                                               probe: { p in
                                                   // The chat list only matters for listing chats, which checks it itself.
                                                   SendAnchors.forTypingIntoOpenChat(base.with(p).probeAnchors())
                                               }) else { throw MuseError.anchorMissing("rules") }
        return MuseSession(muse: base.with(sel.profile), rules: rules, selection: sel, version: ver)
    }

    /// Version of the running Muse app, read from its bundle.
    static func version(of app: NSRunningApplication) -> (short: String?, build: String?) {
        let info = app.bundleURL.flatMap { Bundle(url: $0) }?.infoDictionary
        return (info?["CFBundleShortVersionString"] as? String, info?["CFBundleVersion"] as? String)
    }

    /// JSON fields describing the Muse version, the rules in use, and how far the bridge trusts this UI.
    func versionFields() -> [String: Any] {
        var rulesInfo: [String: Any] = ["source": rules.source, "revision": rules.revision]
        if let k = rules.keyId { rulesInfo["key_id"] = k }
        if let n = rules.note { rulesInfo["note"] = n }
        var out: [String: Any] = [
            "muse_version": ["short": version.short as Any? ?? NSNull(), "build": version.build as Any? ?? NSNull()],
            "version_check": versionCheck,
            "profile": selection.profile.id,
            "rules": rulesInfo,
            "verified_versions": rules.document.profiles.flatMap(\.match.versions),
            "layout": muse.layout.rawValue,
        ]
        if !selection.failedAnchors.isEmpty { out["failed_anchors"] = selection.failedAnchors }
        return out
    }
}
