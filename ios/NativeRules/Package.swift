// swift-tools-version: 5.9
import PackageDescription

// Unit tests for the framework-free plugin rules. NativeRules.swift is also compiled directly
// into the iOS App target (see App.xcodeproj), so the app and these tests share one source.
// Run with: swift test --package-path ios/NativeRules
let package = Package(
    name: "LedHatNativeRules",
    targets: [
        .target(name: "LedHatNativeRules"),
        .testTarget(name: "LedHatNativeRulesTests", dependencies: ["LedHatNativeRules"]),
    ]
)
