import Foundation

public struct FetchFailure: Error, Equatable {
    public let message: String
    /// The body was cut off because it passed the size cap (see `LiveFetcher.fetch(_:maxBytes:)`).
    public let tooLarge: Bool
    public init(_ message: String, tooLarge: Bool = false) { self.message = message; self.tooLarge = tooLarge }
}

public typealias Fetcher = (URL) -> Result<Data, FetchFailure>

public struct RulesUpdateOutcome: Error, Equatable {
    public let updated: Bool
    /// updated | unchanged | not_newer | network_error | bad_signature | untrusted_key | schema_unsupported | invalid_rules | expired | bot_not_listed | bad_url | cache_write_failed
    public let reason: String
    public let revision: Int?
    public let detail: String?
    /// The keyset key that signed the installed rules.
    public let keyId: String?

    public init(updated: Bool, reason: String, revision: Int? = nil, detail: String? = nil, keyId: String? = nil) {
        self.updated = updated; self.reason = reason; self.revision = revision; self.detail = detail; self.keyId = keyId
    }

    public var fields: [String: Any] {
        var f: [String: Any] = ["updated": updated, "reason": reason]
        if let r = revision { f["revision"] = r }
        if let d = detail { f["detail"] = d }
        if let k = keyId { f["key_id"] = k }
        return f
    }
}

/// `muse-ax rules update`: fetch the signed rules file, verify it, replace the cache. Never throws: every
/// problem keeps the rules already in use and is reported as a reason.
public enum RulesUpdater {
    public static let repoRaw = "https://raw.githubusercontent.com/qualixar/claude-bot-bridge/main"
    public static let maxBytes = 512 * 1024

    public static func defaultURL(bot: String, channel: String = "stable") -> String {
        channel == "next" ? "\(repoRaw)/rules/next/\(bot).json" : "\(repoRaw)/rules/\(bot).json"
    }

    /// CBB_RULES_CHANNEL: `next` opts in to rules/next/ (rules still being proven); anything else is `stable`.
    public static func channel(env: [String: String] = ProcessInfo.processInfo.environment) -> String {
        env["CBB_RULES_CHANNEL"] == "next" ? "next" : "stable"
    }

    /// CBB_RULES_URL wins; else the repository file of the chosen channel.
    public static func url(env: [String: String] = ProcessInfo.processInfo.environment, bot: String) -> URL {
        let fallback = defaultURL(bot: bot, channel: channel(env: env))
        let raw = env["CBB_RULES_URL"].flatMap { $0.isEmpty ? nil : $0 } ?? fallback
        return URL(string: raw) ?? URL(string: fallback)!
    }

    /// The signed bot index next to a rules file.
    public static func indexURL(for rules: URL) -> URL { rules.deletingLastPathComponent().appendingPathComponent("index.json") }

    /// https anywhere; plain http only to this machine; file URLs (tests, offline mirrors). The signature, not the
    /// transport, is what makes the content trustworthy.
    public static func isAllowed(_ url: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "https", "file": return true
        case "http": return ["127.0.0.1", "localhost", "::1"].contains(url.host?.lowercased() ?? "")
        default: return false
        }
    }

    public static func update(url: URL, home: URL, bot: String, trust: TrustContext, builtin: RulesDocument, fetch: Fetcher) -> RulesUpdateOutcome {
        guard isAllowed(url) else { return .init(updated: false, reason: "bad_url", detail: "unsupported URL scheme or host") }
        let target: URL
        switch resolveViaIndex(url: url, bot: bot, trust: trust, fetch: fetch) {
        case .failure(let o): return o
        case .success(let u): target = u
        }
        guard let sigURL = URL(string: target.absoluteString + ".sig") else { return .init(updated: false, reason: "bad_url") }
        let json: Data
        switch fetch(target) {
        case .failure(let e): return e.tooLarge ? .init(updated: false, reason: "invalid_rules", detail: "file larger than \(maxBytes) bytes") : .init(updated: false, reason: "network_error", detail: e.message)
        case .success(let d): json = d
        }
        guard json.count <= maxBytes else { return .init(updated: false, reason: "invalid_rules", detail: "file larger than \(maxBytes) bytes") }
        let sig: String
        switch fetch(sigURL) {
        case .failure(let e): return .init(updated: false, reason: "network_error", detail: e.message)
        case .success(let d): sig = String(decoding: d.prefix(1024), as: UTF8.self)
        }
        let keyId: String?
        switch Trust.verify(data: json, signatureBase64: sig, keyId: RulesDocument.peekKeyId(json), use: "rules", ctx: trust) {
        case .untrusted(let why): return untrusted(why, what: nil)
        case .trusted(let id): keyId = id
        }
        return install(json: json, signature: sig, home: home, bot: bot, trust: trust, builtin: builtin, keyId: keyId)
    }

    private static func untrusted(_ why: String, what: String?) -> RulesUpdateOutcome {
        let tail = what.map { " (\($0))" } ?? ""
        if why == "bad_signature" { return .init(updated: false, reason: "bad_signature", detail: "signature does not verify; keeping current rules\(tail)") }
        return .init(updated: false, reason: "untrusted_key", detail: why)
    }

    /// The index (when it can be fetched) names this bot's rules file; a bad index stops the update, a missing one does
    /// not (the rules file next to it is still checked on its own), a bot the index does not list is not updated.
    private static func resolveViaIndex(url: URL, bot: String, trust: TrustContext, fetch: Fetcher) -> Result<URL, RulesUpdateOutcome> {
        let idxURL = indexURL(for: url)
        guard let idxSig = URL(string: idxURL.absoluteString + ".sig"),
              case .success(let body) = fetch(idxURL), body.count <= maxBytes,
              case .success(let sigData) = fetch(idxSig) else { return .success(url) }
        let sig = String(decoding: sigData.prefix(1024), as: UTF8.self)
        if case .untrusted(let why) = Trust.verify(data: body, signatureBase64: sig, keyId: RulesDocument.peekKeyId(body), use: "rules", ctx: trust) {
            return .failure(untrusted(why, what: "index"))
        }
        guard let index = try? RulesIndex.decode(body) else { return .failure(.init(updated: false, reason: "invalid_rules", detail: "the bot index is not valid")) }
        guard let entry = index.entry(for: bot) else {
            return .failure(.init(updated: false, reason: "bot_not_listed", detail: "the bot index does not list \"\(bot)\""))
        }
        return .success(idxURL.deletingLastPathComponent().appendingPathComponent(entry.rules))
    }

    /// Everything after the signature checked out: schema, shape, expiry, freshness, write.
    static func install(json: Data, signature: String, home: URL, bot: String, trust: TrustContext, builtin: RulesDocument, keyId: String?) -> RulesUpdateOutcome {
        let doc: RulesDocument
        do { doc = try RulesDocument.decode(bot: bot, json) } catch RulesError.schemaUnsupported(let n) {
            return .init(updated: false, reason: "schema_unsupported",
                         detail: "rules use schema \(n); this muse-ax reads schema \(RulesDocument.supportedSchema). Update the plugin.")
        } catch {
            return .init(updated: false, reason: "invalid_rules", detail: "\(error)")
        }
        guard !doc.isExpired(at: trust.now) else { return .init(updated: false, reason: "expired", revision: doc.revision, detail: "the rules are past their not_after") }
        let current = RulesStore.load(home: home, bot: bot, trust: trust, builtin: builtin)
        if current.source == "cache", let have = try? Data(contentsOf: RulesStore.cachePaths(home: home, bot: bot).json), have == json {
            return .init(updated: false, reason: "unchanged", revision: doc.revision, keyId: keyId)
        }
        guard doc.revision >= current.revision else {
            return .init(updated: false, reason: "not_newer", revision: doc.revision, detail: "current revision is \(current.revision)")
        }
        do { try RulesStore.writeCache(json: json, signature: signature, home: home, bot: bot) } catch {
            return .init(updated: false, reason: "cache_write_failed", detail: "\(error)")
        }
        return .init(updated: true, reason: "updated", revision: doc.revision, keyId: keyId)
    }
}

/// Real network access for `rules update` and the keyset refresh: a short-timeout GET, or a plain read for file URLs. The size
/// cap is enforced while the body arrives: the transfer is cancelled the moment it passes `maxBytes`, so an oversized or endless
/// response is never held in memory.
public enum LiveFetcher {
    /// What `fetch(_:)` allows when the caller names no limit.
    public static let defaultMaxBytes = RulesUpdater.maxBytes

    public static func fetch(_ url: URL) -> Result<Data, FetchFailure> { fetch(url, maxBytes: defaultMaxBytes) }

    public static func fetch(_ url: URL, maxBytes: Int) -> Result<Data, FetchFailure> {
        url.isFileURL ? readFile(url, maxBytes: maxBytes) : download(url, maxBytes: maxBytes)
    }

    private static func readFile(_ url: URL, maxBytes: Int) -> Result<Data, FetchFailure> {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return .failure(FetchFailure("cannot read \(url.lastPathComponent)")) }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: maxBytes + 1) else { return .failure(FetchFailure("cannot read \(url.lastPathComponent)")) }
        return data.count > maxBytes ? .failure(FetchFailure("larger than \(maxBytes) bytes", tooLarge: true)) : .success(data)
    }

    private static func download(_ url: URL, maxBytes: Int) -> Result<Data, FetchFailure> {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 10; cfg.timeoutIntervalForResource = 15
        cfg.httpCookieStorage = nil; cfg.urlCache = nil
        let collector = BoundedCollector(maxBytes: maxBytes)
        let session = URLSession(configuration: cfg, delegate: collector, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: url)
        task.resume()
        if collector.done.wait(timeout: .now() + 20) == .timedOut { task.cancel(); return .failure(FetchFailure("timed out")) }
        return collector.result()
    }
}

/// Collects a response body up to a cap and cancels the transfer as soon as the cap, or a non-200 status, is seen.
final class BoundedCollector: NSObject, URLSessionDataDelegate {
    let done = DispatchSemaphore(value: 0)
    private let maxBytes: Int
    private let lock = NSLock()
    private var buffer = Data()
    private var failure: FetchFailure?
    private var finished = false

    init(maxBytes: Int) { self.maxBytes = maxBytes }

    private func fail(_ f: FetchFailure) { lock.lock(); if failure == nil { failure = f }; lock.unlock() }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            fail(FetchFailure("HTTP \(http.statusCode)")); completionHandler(.cancel); return
        }
        if response.expectedContentLength > Int64(maxBytes) {
            fail(FetchFailure("larger than \(maxBytes) bytes", tooLarge: true)); completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let over = buffer.count + data.count > maxBytes
        if !over { buffer.append(data) }
        lock.unlock()
        if over { fail(FetchFailure("larger than \(maxBytes) bytes", tooLarge: true)); dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        if failure == nil, let e = error { failure = FetchFailure(e.localizedDescription) }
        let first = !finished
        finished = true
        lock.unlock()
        if first { done.signal() }
    }

    func result() -> Result<Data, FetchFailure> {
        lock.lock(); defer { lock.unlock() }
        if let f = failure { return .failure(f) }
        return .success(buffer)
    }
}
