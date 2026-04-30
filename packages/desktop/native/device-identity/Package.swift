// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MaestroDeviceIdentity",
    platforms: [.macOS(.v12)],
    products: [
        .executable(name: "maestro-device-identity", targets: ["MaestroDeviceIdentity"])
    ],
    targets: [
        .executableTarget(name: "MaestroDeviceIdentity")
    ]
)
