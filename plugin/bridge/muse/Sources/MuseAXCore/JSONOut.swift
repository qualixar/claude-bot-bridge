import Foundation

public enum JSONOut {
    /// Serialises a dictionary to a single JSON line with sorted keys.
    public static func line(_ obj: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .withoutEscapingSlashes]),
              let s = String(data: d, encoding: .utf8) else {
            return #"{"ok":false,"error":{"code":"internal","message":"unserialisable output"}}"#
        }
        return s
    }

    public static func failure(_ e: MuseError) -> String {
        var err: [String: Any] = ["code": e.code, "message": e.message]
        if let d = e.details { err["details"] = d }
        return line(["ok": false, "error": err])
    }

    public static func success(_ fields: [String: Any]) -> String {
        var f = fields; f["ok"] = true
        return line(f)
    }

    public static func messages(_ m: [Message]) -> [[String: Any]] {
        m.map { x in
            var d: [String: Any] = ["role": x.role, "text": x.text]
            if let t = x.time { d["time"] = t }
            return d
        }
    }
}
