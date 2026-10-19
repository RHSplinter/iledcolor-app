import Capacitor
import UIKit

/// Opens the system over-the-air installer for Ad Hoc builds published on GitHub Releases.
@objc(AppUpdaterPlugin)
public class AppUpdaterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppUpdaterPlugin"
    public let jsName = "AppUpdater"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openInstaller", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadAndInstall", returnType: CAPPluginReturnPromise),
    ]

    private static let manifestPrefix = "https://github.com/harrybin/iledcolor-app-native-added/releases/download/"

    @objc func openInstaller(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "itms-services",
              let manifest = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "url" })?.value,
              manifest.hasPrefix(Self.manifestPrefix), manifest.hasSuffix("-ios.plist") else {
            call.reject("Refusing an installer link that is not from this app's GitHub Releases.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { call.resolve() } else { call.reject("iOS could not open the installer.") }
            }
        }
    }

    @objc func downloadAndInstall(_ call: CAPPluginCall) {
        call.unavailable("APK installation is only available on Android.")
    }
}
