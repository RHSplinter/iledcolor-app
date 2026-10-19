import XCTest
@testable import LedHatNativeRules

final class SoundRulesTests: XCTestCase {
    func testSupportedLanguages() {
        XCTAssertTrue(SoundRules.isSupportedLanguage("en-US"))
        XCTAssertTrue(SoundRules.isSupportedLanguage("de-DE"))
        XCTAssertFalse(SoundRules.isSupportedLanguage("en-GB"))
        XCTAssertFalse(SoundRules.isSupportedLanguage(nil))
    }

    func testOutputRateIsCappedAt16kHz() {
        XCTAssertEqual(SoundRules.outputRate(forInputRate: 48_000), 16_000)
        XCTAssertEqual(SoundRules.outputRate(forInputRate: 44_100), 16_000)
        XCTAssertEqual(SoundRules.outputRate(forInputRate: 8_000), 8_000)
    }

    func testClampMono() {
        XCTAssertEqual(SoundRules.clampMono(0.25), 0.25)
        XCTAssertEqual(SoundRules.clampMono(2), 1)
        XCTAssertEqual(SoundRules.clampMono(-2), -1)
        XCTAssertEqual(SoundRules.clampMono(.nan), 0)
        XCTAssertEqual(SoundRules.clampMono(.infinity), 0)
    }

    func testIntegerRatioAveragesBoxes() {
        var sampler = BoxDownsampler(inputRate: 48_000, outputRate: 16_000, frameSize: 2)
        var frames: [[Float]] = []
        for value in [0.0, 0.3, 0.6, 1.0, 1.0, 1.0] {
            sampler.push(value) { frame, remaining in
                frames.append(frame)
                XCTAssertEqual(remaining, 0, accuracy: 1e-6)
            }
        }
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0][0], 0.3, accuracy: 1e-6)
        XCTAssertEqual(frames[0][1], 1.0, accuracy: 1e-6)
        XCTAssertTrue(sampler.samples.isEmpty)
    }

    func testFractionalRatioPreservesExactOutputRate() {
        var sampler = BoxDownsampler(inputRate: 44_100, outputRate: 16_000, frameSize: 16_000)
        var emitted = 0
        for _ in 0..<44_100 { sampler.push(0.5) { frame, _ in emitted += frame.count } }
        XCTAssertLessThanOrEqual(abs(emitted + sampler.samples.count - 16_000), 1)
    }

    func testFractionalRatioKeepsConstantSignal() {
        var sampler = BoxDownsampler(inputRate: 44_100, outputRate: 16_000, frameSize: 64)
        var frames: [[Float]] = []
        for _ in 0..<400 { sampler.push(-0.75) { frame, _ in frames.append(frame) } }
        XCTAssertFalse(frames.isEmpty)
        for sample in frames.flatMap({ $0 }) { XCTAssertEqual(sample, -0.75, accuracy: 1e-5) }
    }

    func testDefaultFrameSizeAndRemainder() {
        var sampler = BoxDownsampler(inputRate: 16_000, outputRate: 16_000)
        XCTAssertEqual(sampler.frameSize, 2048)
        var count = 0
        for _ in 0..<(2048 * 2 + 5) { sampler.push(0.1) { frame, _ in count += 1; XCTAssertEqual(frame.count, 2048) } }
        XCTAssertEqual(count, 2)
        XCTAssertEqual(sampler.samples.count, 5)
    }

    func testResetClearsPartialState() {
        var sampler = BoxDownsampler(inputRate: 48_000, outputRate: 16_000, frameSize: 1)
        sampler.push(1) { _, _ in XCTFail("frame should not be complete") }
        sampler.push(1) { _, _ in XCTFail("frame should not be complete") }
        sampler.reset()
        var frames: [[Float]] = []
        for _ in 0..<3 { sampler.push(0) { frame, _ in frames.append(frame) } }
        XCTAssertEqual(frames, [[0]])
    }

    func testOutputIsClamped() {
        var sampler = BoxDownsampler(inputRate: 16_000, outputRate: 16_000, frameSize: 1)
        var frames: [[Float]] = []
        sampler.push(5) { frame, _ in frames.append(frame) }
        XCTAssertEqual(frames, [[1]])
    }
}
