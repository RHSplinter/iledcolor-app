import Capacitor
import UIKit

/// Registers app-local plugins that are not distributed as npm packages.
class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ApproachBeaconPlugin())
        bridge?.registerPluginInstance(SoundDetectionPlugin())
        bridge?.registerPluginInstance(AppUpdaterPlugin())
    }
}
