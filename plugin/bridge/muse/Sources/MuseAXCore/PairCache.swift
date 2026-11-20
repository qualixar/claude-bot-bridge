import Foundation

/// A downloaded document and its detached signature, cached together. The pair always sits in one fresh directory
/// that `current` points at, so both files are replaced by one symlink swap and a reader never sees a document from
/// one update with a signature from another. Used for the rules (`rules/`) and the keyset (`keys/`).
struct PairCache {
    let root: URL
    let fileName: String
    var signatureName: String { fileName + ".sig" }

    /// Where the pair lives NOW, by name (does not resolve the symlink).
    var currentPaths: (json: URL, sig: URL) {
        let dir = root.appendingPathComponent("current")
        return (dir.appendingPathComponent(fileName), dir.appendingPathComponent(signatureName))
    }

    /// The pair as it is NOW: `current` is resolved once, so both files come from the same version directory even if
    /// an update repoints the symlink between the two reads.
    var snapshotPaths: (json: URL, sig: URL) {
        let target = (try? FileManager.default.destinationOfSymbolicLink(atPath: root.appendingPathComponent("current").path))
            .map { root.appendingPathComponent($0) } ?? root.appendingPathComponent("current")
        return (target.appendingPathComponent(fileName), target.appendingPathComponent(signatureName))
    }

    func read() -> (json: Data, sig: String)? {
        let p = snapshotPaths
        guard let json = try? Data(contentsOf: p.json), let sig = try? String(contentsOf: p.sig, encoding: .utf8) else { return nil }
        return (json, sig)
    }

    /// Writes the pair into a fresh directory, then atomically repoints `current` at it. Writers are serialised by
    /// `.lock` (pid + nonce).
    func write(json: Data, signature: String) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        guard let lock = acquireLock(root.appendingPathComponent(".lock")) else {
            throw MuseError.inputFailed("the \(root.lastPathComponent) cache is being updated by another process; try again.")
        }
        defer { lock.release() }
        let name = "v-\(UUID().uuidString)"
        let dir = root.appendingPathComponent(name)
        try fm.createDirectory(at: dir, withIntermediateDirectories: false)
        do {
            try json.write(to: dir.appendingPathComponent(fileName))
            try Data((signature.trimmingCharacters(in: .whitespacesAndNewlines) + "\n").utf8).write(to: dir.appendingPathComponent(signatureName))
            let previous = try? fm.destinationOfSymbolicLink(atPath: root.appendingPathComponent("current").path)
            try swapCurrent(to: name)
            prune(keep: [name, previous])
        } catch {
            try? fm.removeItem(at: dir)
            throw error
        }
    }

    private func acquireLock(_ url: URL) -> FileLock? {
        for _ in 0..<50 {
            if let l = FileLock.acquire(at: url) { return l }
            usleep(100_000)
        }
        return nil
    }

    private func swapCurrent(to name: String) throws {
        let tmp = root.appendingPathComponent(".current.\(UUID().uuidString)")
        try FileManager.default.createSymbolicLink(atPath: tmp.path, withDestinationPath: name)
        guard rename(tmp.path, root.appendingPathComponent("current").path) == 0 else {
            let err = String(cString: strerror(errno))
            try? FileManager.default.removeItem(at: tmp)
            throw MuseError.inputFailed("could not switch the \(root.lastPathComponent) cache: \(err)")
        }
    }

    /// Keeps the new directory and the one before it (a reader may still be opening it); removes older ones.
    private func prune(keep: [String?]) {
        let keepSet = Set(keep.compactMap { $0 })
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        for n in names where n.hasPrefix("v-") && !keepSet.contains(n) {
            try? FileManager.default.removeItem(at: root.appendingPathComponent(n))
        }
    }
}
