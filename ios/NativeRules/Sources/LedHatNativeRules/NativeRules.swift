import Foundation

// Framework-free rules shared by the iOS plugins. This file is compiled directly into the
// App target and into the LedHatNativeRules Swift package so `swift test` can cover it.

enum BeaconRules {
    static let contentValueCount = 6
    static let maxValueBytes = 512
    static let standardGravity = 9.80665
    static let contentServiceUuid = "4c454448-1000-4000-8000-000000000001"
    static let shareInboxUuid = "4c454448-1000-4000-8000-000000000020"
    static let shareStatusUuid = "4c454448-1000-4000-8000-000000000021"

    /// Characteristic UUID for content slot `index`: slot 0 is the 8-byte header, slots 1-5 are texts.
    static func contentCharacteristicUuid(_ index: Int) -> String {
        String(format: "4c454448-1000-4000-8000-%012ld", index == 0 ? 2 : 9 + index)
    }

    static func isValidContentValue(index: Int, byteCount: Int) -> Bool {
        byteCount <= maxValueBytes && (index != 0 || byteCount == 8)
    }

    /// Decodes six base64 content values, or returns nil when any value is invalid.
    static func decodeContentValues(_ values: [String]?) -> [(uuid: String, data: Data)]? {
        guard let values = values, values.count == contentValueCount else { return nil }
        var decoded: [(uuid: String, data: Data)] = []
        for (index, value) in values.enumerated() {
            guard let data = Data(base64Encoded: value),
                  isValidContentValue(index: index, byteCount: data.count) else { return nil }
            decoded.append((contentCharacteristicUuid(index), data))
        }
        return decoded
    }

    static func decodeStatus(_ raw: String?) -> Data? {
        guard let raw = raw, let data = Data(base64Encoded: raw), data.count <= maxValueBytes else { return nil }
        return data
    }

    /// Senders keep every packet within one ATT write; an offset means an unsupported long write.
    static func isAcceptedShareWrite(isInbox: Bool, offset: Int, byteCount: Int) -> Bool {
        isInbox && offset == 0 && byteCount <= maxValueBytes
    }

    /// Remaining bytes for a read at `offset`, or nil when the offset is past the value.
    static func readSlice(_ value: Data, offset: Int) -> Data? {
        guard offset >= 0, offset <= value.count else { return nil }
        return value.subdata(in: value.startIndex + offset..<value.endIndex)
    }

    static func trimmedName(_ name: String?) -> String? {
        let trimmed = name?.trimmingCharacters(in: .whitespaces) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func magnitude(_ x: Double, _ y: Double, _ z: Double) -> Double {
        (x * x + y * y + z * z).squareRoot()
    }
}

enum UpdateRules {
    static let manifestPrefix = "https://github.com/harrybin/iledcolor-app-native-added/releases/download/"

    /// Accepts only itms-services links whose manifest is an iOS plist on this app's GitHub Releases.
    static func isTrustedInstallerUrl(_ raw: String?) -> Bool {
        guard let raw = raw, let url = URL(string: raw), url.scheme == "itms-services",
              let manifest = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "url" })?.value else { return false }
        return manifest.hasPrefix(manifestPrefix) && manifest.hasSuffix("-ios.plist")
    }
}

enum SoundRules {
    static let supportedLanguages = ["en-US", "de-DE"]
    static let maxOutputRate = 16_000.0
    static let frameSize = 2048

    static func isSupportedLanguage(_ language: String?) -> Bool {
        guard let language = language else { return false }
        return supportedLanguages.contains(language)
    }

    static func outputRate(forInputRate inputRate: Double) -> Double {
        min(maxOutputRate, inputRate)
    }

    /// Clamps a mixed mono sample to [-1, 1]; non-finite input becomes silence.
    static func clampMono(_ mono: Double) -> Double {
        mono.isFinite ? max(-1, min(1, mono)) : 0
    }
}

/// Fractional box integration low-pass filters before downsampling and preserves the exact
/// output rate, including 44.1 kHz inputs and tap-boundary remainders.
struct BoxDownsampler {
    let width: Double
    let frameSize: Int
    private(set) var samples: [Float] = []
    private var weightedSample = 0.0
    private var sampleWeight = 0.0

    init(inputRate: Double, outputRate: Double, frameSize: Int = SoundRules.frameSize) {
        width = inputRate / outputRate
        self.frameSize = frameSize
        samples.reserveCapacity(frameSize)
    }

    /// Adds one input sample. `onFrame` receives each completed frame and the unused fraction
    /// of this input sample, which callers use to timestamp the frame end.
    mutating func push(_ mono: Double, onFrame: ([Float], Double) -> Void) {
        var remaining = 1.0
        while remaining > 0.0000001 {
            let portion = min(remaining, width - sampleWeight)
            weightedSample += mono * portion
            sampleWeight += portion
            remaining -= portion
            if sampleWeight >= width - 0.0000001 {
                samples.append(Float(max(-1, min(1, weightedSample / width))))
                weightedSample = 0
                sampleWeight = 0
                if samples.count == frameSize {
                    onFrame(samples, remaining)
                    samples.removeAll(keepingCapacity: true)
                }
            }
        }
    }

    mutating func reset() {
        samples.removeAll(keepingCapacity: true)
        weightedSample = 0
        sampleWeight = 0
    }
}
