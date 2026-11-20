// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "muse-ax",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "muse-ax", targets: ["muse-ax"])],
    targets: [
        .target(name: "MuseAXCore"),
        .executableTarget(name: "muse-ax", dependencies: ["MuseAXCore"]),
        .testTarget(name: "MuseAXCoreTests", dependencies: ["MuseAXCore"]),
    ]
)
