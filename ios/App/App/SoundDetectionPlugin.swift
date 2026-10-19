import AVFoundation
import Capacitor
import Speech
import UIKit

@objc(SoundDetectionPlugin)
public class SoundDetectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SoundDetectionPlugin"
    public let jsName = "SoundDetection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    // All capture/recognition state belongs to this queue, never the real-time tap.
    private let audioQueue = DispatchQueue(label: "app.sound-detection", qos: .userInitiated)
    private var generation = UUID()
    private var pendingStart: CAPPluginCall?
    private var active = false
    private var engine: AVAudioEngine?
    private var ownsAudioSession = false
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var speechGeneration = UUID()
    private var requestStart: Double?
    private var requestEnd = 0.0
    private var epochOffset = 0.0
    private var inputRate = 0.0
    private var outputRate = 0.0
    private var downsampler = BoxDownsampler(inputRate: 1, outputRate: 1)

    // UIKit state is exclusively accessed on the main queue.
    private var proximityGeneration: UUID?
    private var previousProximityMonitoring = false
    private var proximityObserver: NSObjectProtocol?
    private var lastAudioEmission = -Double.infinity

    public override func load() {
        let center = NotificationCenter.default
        // Proximity blanks the screen and can resign active: that is NOT backgrounding.
        center.addObserver(self, selector: #selector(backgrounded),
                           name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(backgrounded),
                           name: UIScene.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(backgrounded),
                           name: UIApplication.willTerminateNotification, object: nil)
        center.addObserver(self, selector: #selector(backgrounded),
                           name: AVAudioSession.mediaServicesWereLostNotification, object: nil)
        center.addObserver(self, selector: #selector(backgrounded),
                           name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        center.addObserver(self, selector: #selector(interrupted(_:)),
                           name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(routeChanged(_:)),
                           name: AVAudioSession.routeChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(engineChanged),
                           name: .AVAudioEngineConfigurationChange, object: nil)
    }

    private static var supportsProximity: Bool {
        #if targetEnvironment(simulator) || targetEnvironment(macCatalyst)
        return false
        #else
        return UIDevice.current.userInterfaceIdiom == .phone && UIDevice.current.model == "iPhone"
            && !ProcessInfo.processInfo.isiOSAppOnMac
        #endif
    }

    private static func onDeviceRecognizer(_ language: String) -> SFSpeechRecognizer? {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)),
              recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else { return nil }
        return recognizer
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let status = SFSpeechRecognizer.authorizationStatus()
            let speech = status != .denied && status != .restricted
                && SoundRules.supportedLanguages.contains { Self.onDeviceRecognizer($0) != nil }
            call.resolve(["speech": speech, "proximity": Self.supportsProximity])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let language = call.getString("language"), SoundRules.isSupportedLanguage(language),
              let speech = call.getBool("speech") else {
            call.reject("Expected language en-US or de-DE and a speech boolean", "INVALID_ARGUMENT")
            return
        }
        audioQueue.async {
            guard !self.active, self.pendingStart == nil else {
                call.reject("Sound detection is already running or starting", "ALREADY_STARTED")
                return
            }
            let token = UUID()
            self.generation = token
            self.pendingStart = call
            self.requestMicrophone(token: token, language: language, speech: speech)
        }
    }

    private func requestMicrophone(token: UUID, language: String, speech: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.audioQueue.async {
                guard self.generation == token, self.pendingStart != nil else { return }
                // Permission APIs run on main; callbacks always re-enter the state queue.
                DispatchQueue.main.async { [weak self] in
                    AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                        guard let self = self else { return }
                        self.audioQueue.async {
                            guard self.generation == token, self.pendingStart != nil else { return }
                            guard granted else {
                                self.fail("Microphone permission denied", code: "PERMISSION_DENIED")
                                return
                            }
                            if speech { self.requestSpeech(token: token, language: language) }
                            else { self.beginCapture(token: token, language: nil) }
                        }
                    }
                }
            }
        }
    }

    private func requestSpeech(token: UUID, language: String) {
        guard Self.onDeviceRecognizer(language) != nil else {
            fail("On-device speech recognition is unavailable for \(language)", code: "UNAVAILABLE")
            return
        }
        DispatchQueue.main.async { [weak self] in
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                guard let self = self else { return }
                self.audioQueue.async {
                    guard self.generation == token, self.pendingStart != nil else { return }
                    guard status == .authorized else {
                        self.fail("Speech recognition permission denied", code: "PERMISSION_DENIED")
                        return
                    }
                    self.beginCapture(token: token, language: language)
                }
            }
        }
    }

    private func beginCapture(token: UUID, language: String?) {
        guard generation == token, pendingStart != nil else { return }
        // Check actual foreground state after permission dialogs, not resign-active notifications.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let foreground = UIApplication.shared.applicationState != .background
            self.audioQueue.async {
                guard self.generation == token, self.pendingStart != nil else { return }
                guard foreground else {
                    self.fail("Sound detection requires the foreground", code: "UNAVAILABLE")
                    return
                }
                self.configureCapture(token: token, language: language)
            }
        }
    }

    private func configureCapture(token: UUID, language: String?) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
            ownsAudioSession = true
            let engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0,
                  format.commonFormat == .pcmFormatFloat32, !format.isInterleaved else {
                throw CaptureError("Microphone PCM format is unsupported")
            }
            inputRate = format.sampleRate
            outputRate = SoundRules.outputRate(forInputRate: inputRate)
            epochOffset = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
            downsampler = BoxDownsampler(inputRate: inputRate, outputRate: outputRate)
            if let language = language {
                guard let recognizer = Self.onDeviceRecognizer(language) else {
                    throw CaptureError("On-device speech recognition is unavailable for \(language)")
                }
                self.recognizer = recognizer
                beginSpeech(token: token)
            }
            self.engine = engine
            let mailbox = TapMailbox()
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, time in
                guard let self = self, mailbox.reserve() else { return }
                // The tap buffer is reused by AVAudioEngine after this callback.
                guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
                    mailbox.release()
                    return
                }
                copy.frameLength = buffer.frameLength
                let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
                for index in source.indices {
                    if let from = source[index].mData, let to = destination[index].mData {
                        memcpy(to, from, Int(source[index].mDataByteSize))
                    }
                }
                let firstFrame = time.isHostTimeValid
                    ? AVAudioTime.seconds(forHostTime: time.hostTime)
                    : ProcessInfo.processInfo.systemUptime - Double(buffer.frameLength) / buffer.format.sampleRate
                self.audioQueue.async {
                    defer { mailbox.release() }
                    guard self.generation == token, self.active else { return }
                    if mailbox.hasDroppedAudio {
                        self.fail("Audio processing could not keep up with the microphone")
                        return
                    }
                    self.consume(copy, firstFrame: firstFrame)
                }
            }
            engine.prepare()
            try engine.start()
            active = true
            let call = pendingStart
            pendingStart = nil
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.enableProximity(token: token)
                call?.resolve()
            }
        } catch {
            fail("Could not start sound detection: \(error.localizedDescription)")
        }
    }

    private func consume(_ buffer: AVAudioPCMBuffer, firstFrame: Double) {
        guard let channels = buffer.floatChannelData else { return }
        let start = (epochOffset + firstFrame) * 1000
        if requestStart == nil { requestStart = start }
        requestEnd = start + Double(buffer.frameLength) / inputRate * 1000
        request?.append(buffer)
        let inputRate = self.inputRate
        let outputRate = self.outputRate
        for frame in 0..<Int(buffer.frameLength) {
            var mono = 0.0
            for channel in 0..<Int(buffer.format.channelCount) {
                mono += Double(channels[channel][frame]) / Double(buffer.format.channelCount)
            }
            downsampler.push(SoundRules.clampMono(mono)) { samples, remaining in
                let end = start + (Double(frame + 1) - remaining) / inputRate * 1000
                emit("audio", ["samples": samples.map { Double($0) },
                               "sampleRate": outputRate, "at": end])
            }
        }
    }

    private func beginSpeech(token: UUID) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        self.request = request
        requestStart = nil
        requestEnd = 0
        let speechToken = UUID()
        speechGeneration = speechToken
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            self.audioQueue.async {
                guard self.generation == token, self.speechGeneration == speechToken,
                      self.active else { return }
                if let result = result, result.isFinal {
                    let transcription = result.bestTranscription
                    if let start = self.requestStart,
                       let first = transcription.segments.first,
                       let last = transcription.segments.last,
                       !transcription.formattedString.isEmpty {
                        let from = max(start, start + first.timestamp * 1000)
                        let to = min(self.requestEnd, start + (last.timestamp + last.duration) * 1000)
                        if to >= from {
                            self.emit("phrase", ["text": transcription.formattedString, "from": from, "to": to])
                        }
                    }
                    self.speechGeneration = UUID()
                    self.request?.endAudio()
                    self.task?.cancel()
                    self.task = nil
                    self.beginSpeech(token: token)
                } else if let error = error {
                    self.fail("On-device speech recognition failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func enableProximity(token: UUID) {
        proximityGeneration = token
        guard Self.supportsProximity else { return }
        let device = UIDevice.current
        previousProximityMonitoring = device.isProximityMonitoringEnabled
        device.isProximityMonitoringEnabled = true
        guard device.isProximityMonitoringEnabled else { return }
        proximityObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.proximityStateDidChangeNotification, object: device, queue: .main
        ) { [weak self] _ in
            self?.sendProximity(token: token)
        }
        sendProximity(token: token)
    }

    private func sendProximity(token: UUID) {
        guard proximityGeneration == token else { return }
        let near = UIDevice.current.proximityState
        audioQueue.async {
            guard self.generation == token, self.active else { return }
            self.emit("proximity", ["near": near])
        }
    }

    private func disableProximity() {
        guard proximityGeneration != nil else { return }
        proximityGeneration = nil
        if let observer = proximityObserver {
            NotificationCenter.default.removeObserver(observer)
            proximityObserver = nil
        }
        if Self.supportsProximity {
            UIDevice.current.isProximityMonitoringEnabled = previousProximityMonitoring
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        audioQueue.async {
            self.finish()
            DispatchQueue.main.async { call.resolve() }
        }
    }

    private func emit(_ name: String, _ data: [String: Any] = [:]) {
        // One ordered delivery queue ensures ended follows all events of this session.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if name == "audio" {
                // Throttle at delivery, not capture: a busy main queue must not burst.
                let now = ProcessInfo.processInfo.systemUptime
                guard now - self.lastAudioEmission >= 1.0 / 16.0 else { return }
                self.lastAudioEmission = now
            }
            self.notifyListeners(name, data: data)
        }
    }

    private func fail(_ message: String, code: String = "UNAVAILABLE") {
        pendingStart?.reject(message, code)
        pendingStart = nil
        emit("error", ["message": message])
        finish(forceEnded: true)
    }

    private func finish(forceEnded: Bool = false) {
        let hadSession = active || pendingStart != nil || forceEnded
        generation = UUID()
        speechGeneration = UUID()
        active = false
        pendingStart?.reject("Sound detection start was cancelled", "CANCELLED")
        pendingStart = nil
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        recognizer = nil
        requestStart = nil
        downsampler.reset()
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsAudioSession = false
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.disableProximity()
            if hadSession { self.notifyListeners("ended", data: [:]) }
        }
    }

    @objc private func backgrounded() { audioQueue.async { self.finish() } }

    @objc private func interrupted(_ notification: Notification) {
        guard let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              type == AVAudioSession.InterruptionType.began.rawValue else { return }
        audioQueue.async { self.finish() }
    }

    @objc private func routeChanged(_ notification: Notification) {
        guard let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
        audioQueue.async {
            if self.active { self.fail("The microphone was disconnected") }
        }
    }

    @objc private func engineChanged() {
        audioQueue.async {
            guard self.active, let engine = self.engine else { return }
            if !engine.isRunning || engine.inputNode.outputFormat(forBus: 0).sampleRate != self.inputRate {
                self.fail("The microphone configuration changed; start detection again")
            }
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        if ownsAudioSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        pendingStart?.reject("Sound detection was destroyed", "CANCELLED")
        if active || pendingStart != nil { notifyListeners("ended", data: [:]) }
        let observer = proximityObserver
        let restore = proximityGeneration != nil
        let previous = previousProximityMonitoring
        DispatchQueue.main.async {
            if let observer = observer { NotificationCenter.default.removeObserver(observer) }
            if restore, SoundDetectionPlugin.supportsProximity {
                UIDevice.current.isProximityMonitoringEnabled = previous
            }
        }
    }
}

private struct CaptureError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

private final class TapMailbox {
    private let lock = NSLock()
    private var pending = 0
    private var dropped = false

    func reserve() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard pending < 4 else { dropped = true; return false }
        pending += 1
        return true
    }

    func release() {
        lock.lock()
        pending -= 1
        lock.unlock()
    }

    var hasDroppedAudio: Bool {
        lock.lock()
        defer { lock.unlock() }
        return dropped
    }
}
