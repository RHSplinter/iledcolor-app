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
        CAPPluginMethod(name: "publishContent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setShareStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMotion", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMotion", returnType: CAPPluginReturnPromise),
    ]

    private var manager: CBPeripheralManager?
    private var pendingUuid: CBUUID?
    private var pendingName: String?
    private var pendingCall: CAPPluginCall?
    private let contentService = CBUUID(string: BeaconRules.contentServiceUuid)
    private var contentValues: [CBUUID: Data] = [:]
    /// Preset sharing (presetShare.ts): nearby phones write offers/data to the inbox and read the status.
    private let shareInbox = CBUUID(string: BeaconRules.shareInboxUuid)
    private let shareStatusUuid = CBUUID(string: BeaconRules.shareStatusUuid)
    private var shareStatus = Data()
    private var contentCall: CAPPluginCall?
    private var contentReady = false
    private var contentAdding = false
    private var publishedService: CBMutableService?
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
                "acceleration": BeaconRules.magnitude(a.x, a.y, a.z) * BeaconRules.standardGravity,
                "rotation": BeaconRules.magnitude(r.x, r.y, r.z),
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

    @objc func publishContent(_ call: CAPPluginCall) {
        guard let values = call.getArray("values", String.self), values.count == BeaconRules.contentValueCount else {
            call.reject("Six content values required"); return
        }
        guard let decoded = BeaconRules.decodeContentValues(values) else {
            call.reject("Invalid content value"); return
        }
        var next: [CBUUID: Data] = [:]
        for (uuid, data) in decoded { next[CBUUID(string: uuid)] = data }
        DispatchQueue.main.async {
            guard self.contentCall == nil else { call.reject("Content service is starting"); return }
            self.contentValues = next
            if self.contentReady { call.resolve(); return }
            self.contentCall = call
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                guard self.contentCall === call else { return }
                self.contentCall = nil
                self.contentAdding = false
                self.publishedService = nil
                self.manager?.removeAllServices()
                call.reject("Shared text service timed out; retrying")
            }
            if let manager = self.manager {
                if manager.state == .poweredOn { self.addContentService(manager) }
                else if manager.state == .poweredOff || manager.state == .unauthorized || manager.state == .unsupported {
                    self.contentCall = nil
                    call.reject("Bluetooth is off or unavailable")
                }
            } else { self.manager = CBPeripheralManager(delegate: self, queue: nil) }
        }
    }

    private func addContentService(_ peripheral: CBPeripheralManager) {
        guard !contentReady, !contentAdding, !contentValues.isEmpty else { return }
        let service = CBMutableService(type: contentService, primary: true)
        service.characteristics = contentValues.keys.map {
            CBMutableCharacteristic(type: $0, properties: [.read], value: nil, permissions: [.readable])
        } + [
            CBMutableCharacteristic(type: shareStatusUuid, properties: [.read], value: nil, permissions: [.readable]),
            CBMutableCharacteristic(type: shareInbox, properties: [.write], value: nil, permissions: [.writeable]),
        ]
        contentAdding = true
        publishedService = service
        peripheral.add(service)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard service === publishedService else { return }
        contentAdding = false
        if let error = error { contentCall?.reject("Could not publish shared texts: \(error.localizedDescription)") }
        else { contentReady = true; contentCall?.resolve() }
        contentCall = nil
    }

    @objc func setShareStatus(_ call: CAPPluginCall) {
        guard let data = BeaconRules.decodeStatus(call.getString("value")) else {
            call.reject("Invalid status"); return
        }
        DispatchQueue.main.async {
            self.shareStatus = data
            call.resolve()
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard requests.allSatisfy({
            BeaconRules.isAcceptedShareWrite(isInbox: $0.characteristic.uuid == shareInbox,
                                             offset: $0.offset, byteCount: $0.value?.count ?? 0)
        }) else {
            peripheral.respond(to: first, withResult: .requestNotSupported); return
        }
        for request in requests {
            if let value = request.value { notifyListeners("shareWrite", data: ["value": value.base64EncodedString()]) }
        }
        peripheral.respond(to: first, withResult: .success)
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        let uuid = request.characteristic.uuid
        guard let value = uuid == shareStatusUuid ? shareStatus : contentValues[uuid] else {
            peripheral.respond(to: request, withResult: .readNotPermitted); return
        }
        guard let slice = BeaconRules.readSlice(value, offset: request.offset) else {
            peripheral.respond(to: request, withResult: .invalidOffset); return
        }
        request.value = slice
        peripheral.respond(to: request, withResult: .success)
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("uuid"), UUID(uuidString: raw) != nil else {
            call.reject("uuid required"); return
        }
        let name = BeaconRules.trimmedName(call.getString("name"))
        DispatchQueue.main.async {
            self.pendingUuid = CBUUID(string: raw)
            self.pendingName = name
            self.pendingCall = call
            if let m = self.manager, m.state == .poweredOn { self.advertise(m) }
            else if self.manager == nil { self.manager = CBPeripheralManager(delegate: self, queue: nil) }
            else if self.manager?.state == .poweredOff || self.manager?.state == .unauthorized || self.manager?.state == .unsupported {
                self.pendingCall = nil
                call.reject("Bluetooth is off or unavailable")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.manager?.stopAdvertising()
            self.manager?.removeAllServices()
            self.pendingUuid = nil
            self.contentValues = [:]
            self.contentReady = false
            self.contentAdding = false
            self.publishedService = nil
            self.contentCall?.reject("Shared text service stopped")
            self.contentCall = nil
            self.pendingCall?.reject("Beacon stopped")
            self.pendingCall = nil
            call.resolve()
        }
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
        case .poweredOn: addContentService(peripheral); advertise(peripheral)
        case .unauthorized, .poweredOff, .unsupported:
            pendingCall?.reject("Bluetooth is off or unavailable"); pendingCall = nil
            contentCall?.reject("Bluetooth is off or unavailable"); contentCall = nil
            contentReady = false
            contentAdding = false
            publishedService = nil
        default: break
        }
    }

    public func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let e = error { pendingCall?.reject("Advertising failed: \(e.localizedDescription)") }
        else { pendingCall?.resolve(["advertising": true]) }
        pendingCall = nil
    }
}
