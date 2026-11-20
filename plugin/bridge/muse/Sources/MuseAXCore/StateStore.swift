import Foundation

/// ~/.claude-bot-bridge/state.json: small shared state (canary, update timestamps). The Node server
/// writes it too, so every write keeps keys it does not know and goes through an atomic rename.
public enum StateStore {
    static func file(_ home: URL) -> URL { home.appendingPathComponent("state.json") }

    public static func read(home: URL) -> [String: Any] {
        guard let d = try? Data(contentsOf: file(home)),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        return o
    }

    public static func merge(_ updates: [String: Any], home: URL) throws {
        var state = read(home: home)
        for (k, v) in updates { state[k] = v }
        let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys, .prettyPrinted])
        try AtomicFile.write(data, to: file(home))
    }
}

public enum AtomicFile {
    /// Writes next to the target and renames over it, so readers never see half a file.
    public static func write(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: tmp)
        if rename(tmp.path, url.path) != 0 {
            let err = String(cString: strerror(errno))
            try? fm.removeItem(at: tmp)
            throw MuseError.inputFailed("could not write \(url.lastPathComponent): \(err)")
        }
    }
}
