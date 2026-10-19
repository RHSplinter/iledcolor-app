import Foundation
import XCTest
@testable import LedHatNativeRules

final class BeaconRulesTests: XCTestCase {
    private func b64(_ count: Int) -> String { Data(repeating: 0x41, count: count).base64EncodedString() }
    private func validValues() -> [String] { [b64(8), b64(0), b64(1), b64(512), b64(3), b64(4)] }

    func testContentCharacteristicUuidsMatchAndroidAndWeb() {
        XCTAssertEqual(BeaconRules.contentCharacteristicUuid(0), "4c454448-1000-4000-8000-000000000002")
        XCTAssertEqual(BeaconRules.contentCharacteristicUuid(1), "4c454448-1000-4000-8000-000000000010")
        XCTAssertEqual(BeaconRules.contentCharacteristicUuid(5), "4c454448-1000-4000-8000-000000000014")
    }

    func testHeaderMustBeExactlyEightBytes() {
        XCTAssertTrue(BeaconRules.isValidContentValue(index: 0, byteCount: 8))
        XCTAssertFalse(BeaconRules.isValidContentValue(index: 0, byteCount: 7))
        XCTAssertFalse(BeaconRules.isValidContentValue(index: 0, byteCount: 9))
        XCTAssertTrue(BeaconRules.isValidContentValue(index: 3, byteCount: 0))
        XCTAssertTrue(BeaconRules.isValidContentValue(index: 3, byteCount: 512))
        XCTAssertFalse(BeaconRules.isValidContentValue(index: 3, byteCount: 513))
    }

    func testDecodeContentValuesMapsSlotsToUuids() throws {
        let decoded = try XCTUnwrap(BeaconRules.decodeContentValues(validValues()))
        XCTAssertEqual(decoded.count, 6)
        XCTAssertEqual(decoded[0].uuid, "4c454448-1000-4000-8000-000000000002")
        XCTAssertEqual(decoded[0].data.count, 8)
        XCTAssertEqual(decoded[3].uuid, "4c454448-1000-4000-8000-000000000012")
        XCTAssertEqual(decoded[3].data.count, 512)
    }

    func testDecodeContentValuesRejectsInvalidInput() {
        XCTAssertNil(BeaconRules.decodeContentValues(nil))
        XCTAssertNil(BeaconRules.decodeContentValues(Array(validValues().prefix(5))))
        var badBase64 = validValues(); badBase64[2] = "not base64!"
        XCTAssertNil(BeaconRules.decodeContentValues(badBase64))
        var tooLong = validValues(); tooLong[4] = b64(513)
        XCTAssertNil(BeaconRules.decodeContentValues(tooLong))
        var badHeader = validValues(); badHeader[0] = b64(4)
        XCTAssertNil(BeaconRules.decodeContentValues(badHeader))
    }

    func testDecodeStatus() {
        XCTAssertEqual(BeaconRules.decodeStatus(b64(512))?.count, 512)
        XCTAssertEqual(BeaconRules.decodeStatus("")?.count, 0)
        XCTAssertNil(BeaconRules.decodeStatus(b64(513)))
        XCTAssertNil(BeaconRules.decodeStatus("%%%"))
        XCTAssertNil(BeaconRules.decodeStatus(nil))
    }

    func testShareWritesMustBeSingleInboxPackets() {
        XCTAssertTrue(BeaconRules.isAcceptedShareWrite(isInbox: true, offset: 0, byteCount: 512))
        XCTAssertFalse(BeaconRules.isAcceptedShareWrite(isInbox: false, offset: 0, byteCount: 1))
        XCTAssertFalse(BeaconRules.isAcceptedShareWrite(isInbox: true, offset: 1, byteCount: 1))
        XCTAssertFalse(BeaconRules.isAcceptedShareWrite(isInbox: true, offset: 0, byteCount: 513))
    }

    func testReadSliceHonoursOffsets() {
        let value = Data([1, 2, 3, 4])
        XCTAssertEqual(BeaconRules.readSlice(value, offset: 0), value)
        XCTAssertEqual(BeaconRules.readSlice(value, offset: 2), Data([3, 4]))
        XCTAssertEqual(BeaconRules.readSlice(value, offset: 4), Data())
        XCTAssertNil(BeaconRules.readSlice(value, offset: 5))
        XCTAssertNil(BeaconRules.readSlice(value, offset: -1))
        let sliced = Data([9, 9, 7, 8]).subdata(in: 2..<4)
        XCTAssertEqual(BeaconRules.readSlice(sliced, offset: 1), Data([8]))
    }

    func testTrimmedName() {
        XCTAssertEqual(BeaconRules.trimmedName("  Alice "), "Alice")
        XCTAssertNil(BeaconRules.trimmedName("   "))
        XCTAssertNil(BeaconRules.trimmedName(nil))
    }

    func testMotionMagnitude() {
        XCTAssertEqual(BeaconRules.magnitude(3, 4, 12), 13, accuracy: 1e-9)
        XCTAssertEqual(BeaconRules.magnitude(0, 0, 0), 0)
        XCTAssertEqual(BeaconRules.magnitude(1, 0, 0) * BeaconRules.standardGravity, 9.80665, accuracy: 1e-9)
    }
}
