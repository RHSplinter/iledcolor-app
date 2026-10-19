import XCTest
@testable import LedHatNativeRules

final class UpdateRulesTests: XCTestCase {
    private let manifest = "https://github.com/harrybin/iledcolor-app-native-added/releases/download/v1.2.3/ledhat-1.2.3-ios.plist"

    private func link(_ manifestUrl: String, scheme: String = "itms-services") -> String {
        var components = URLComponents()
        components.scheme = scheme
        components.host = ""
        components.queryItems = [URLQueryItem(name: "action", value: "download-manifest"),
                                 URLQueryItem(name: "url", value: manifestUrl)]
        return components.string!
    }

    func testAcceptsReleaseManifest() {
        XCTAssertTrue(UpdateRules.isTrustedInstallerUrl(link(manifest)))
        XCTAssertTrue(UpdateRules.isTrustedInstallerUrl("itms-services://?action=download-manifest&url=\(manifest)"))
    }

    func testRejectsOtherSchemes() {
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(link(manifest, scheme: "https")))
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(manifest))
    }

    func testRejectsForeignOrNonIosManifests() {
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(link("https://evil.example/releases/download/x-ios.plist")))
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(link("https://github.com/someone/else/releases/download/v1/x-ios.plist")))
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(link(manifest.replacingOccurrences(of: "-ios.plist", with: ".plist"))))
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(link(manifest + ".evil")))
    }

    func testRejectsMissingManifestOrUrl() {
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl("itms-services://?action=download-manifest"))
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(""))
        XCTAssertFalse(UpdateRules.isTrustedInstallerUrl(nil))
    }
}
