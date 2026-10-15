import Capacitor
import CoreBluetooth
import CoreMotion
import UIKit

/// Advertises this phone as an approach-mode participant. iOS peripherals may only
/// advertise service UUIDs and a local name, so the payload is packed into one 128-bit UUID.
/// Note: iOS stops advertising custom UUIDs in the foreground format once the app is backgrounded.
@objc(ApproachBeaconPlugin)
public class ApproachBeaconPlugin: CAPPlugin, CAPBridgedPlugin, CBPeripheralManagerDelegate {
    public let identifier = "ApproachBeaconPlugin"
    public let jsName = "ApproachBeacon"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMotion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMotion", returnType: CAPPluginReturnPromise),
    ]

    private var manager: CBPeripheralManager?
    private var pendingUuid: CBUUID?
    private var pendingName: String?
    private var pendingCall: CAPPluginCall?
    private let motion = CMMotionManager()
    private var motionRequested = false

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(pauseMotion),
            name: UIScene.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(resumeMotion),
            name: UIScene.didActivateNotification, object: nil)
    }

    @objc func startMotion(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.motion.isDeviceMotionAvailable else {
                call.reject("Device motion sensors unavailable", "UNAVAILABLE")
                return
            }
            self.motionRequested = true
            self.beginMotion()
            call.resolve()
        }
    }

    private func beginMotion() {
        motion.stopDeviceMotionUpdates()
        motion.deviceMotionUpdateInterval = 0.1
        // The arbitrary reference frame needs no compass or location permission.
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] data, error in
            guard let self = self, self.motionRequested else { return }
            if let error = error {
                self.motion.stopDeviceMotionUpdates()
                self.motionRequested = false
                self.notifyListeners("motionError", data: ["message": error.localizedDescription])
                return
            }
            guard let data = data else { return }
            let a = data.userAcceleration
            let r = data.rotationRate
            self.notifyListeners("motion", data: [
                "acceleration": sqrt(a.x * a.x + a.y * a.y + a.z * a.z) * 9.80665,
                "rotation": sqrt(r.x * r.x + r.y * r.y + r.z * r.z),
            ])
        }
    }

    @objc func stopMotion(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.motionRequested = false
            self.motion.stopDeviceMotionUpdates()
            call.resolve()
        }
    }

    @objc private func pauseMotion() { motion.stopDeviceMotionUpdates() }

    @objc private func resumeMotion() {
        if motionRequested { beginMotion() }
    }

    deinit {
        motion.stopDeviceMotionUpdates()
        NotificationCenter.default.removeObserver(self)
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("uuid"), UUID(uuidString: raw) != nil else {
            call.reject("uuid required"); return
        }
        pendingUuid = CBUUID(string: raw)
        let name = call.getString("name")?.trimmingCharacters(in: .whitespaces) ?? ""
        pendingName = name.isEmpty ? nil : name
        pendingCall = call
        if let m = manager, m.state == .poweredOn { advertise(m) }
        else if manager == nil { manager = CBPeripheralManager(delegate: self, queue: nil) }
    }

    @objc func stop(_ call: CAPPluginCall) {
        manager?.stopAdvertising()
        pendingUuid = nil
        call.resolve()
    }

    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    private func advertise(_ m: CBPeripheralManager) {
        guard let uuid = pendingUuid else { return }
        m.stopAdvertising()
        var ad: [String: Any] = [CBAdvertisementDataServiceUUIDsKey: [uuid]]
        // iOS cannot send manufacturer data; the user name goes out as the local name instead.
        if let n = pendingName { ad[CBAdvertisementDataLocalNameKey] = n }
        m.startAdvertising(ad)
    }

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn: advertise(peripheral)
        case .unauthorized: pendingCall?.reject("Bluetooth permission denied"); pendingCall = nil
        case .poweredOff: pendingCall?.reject("Bluetooth is off"); pendingCall = nil
        case .unsupported: pendingCall?.reject("This device cannot advertise BLE"); pendingCall = nil
        default: break
        }
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let e = error { pendingCall?.reject("Advertising failed: \(e.localizedDescription)") }
        else { pendingCall?.resolve(["advertising": true]) }
        pendingCall = nil
    }
}
