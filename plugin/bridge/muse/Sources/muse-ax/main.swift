import Foundation
import MuseAXCore

setvbuf(stdout, nil, _IOLBF, 0)
do {
    let cmd = try ArgParser.parse(Array(CommandLine.arguments.dropFirst()))
    let out = try Commands.run(cmd)
    if case .doctor(_, true) = cmd, let report = out["report"] as? String { print(report) } else { print(JSONOut.success(out)) }
} catch let e as MuseError {
    print(JSONOut.failure(e))
    exit(e.code == "invalid_argument" ? 2 : 1)
} catch {
    print(JSONOut.failure(.inputFailed("\(error)")))
    exit(1)
}
