// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-saved-browser",
    platforms: [
        .iOS(.v14),
    ],
    products: [
        .library(
            name: "tauri-plugin-saved-browser",
            type: .static,
            targets: ["tauri-plugin-saved-browser"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-saved-browser",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
