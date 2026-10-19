package com.harrybin.ledhat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import org.junit.Test;

public class BeaconRulesTest {
    @Test
    public void mapsContentValuesToTheCharacteristicsReadByBeaconCodec() {
        assertEquals(UUID.fromString("4c454448-1000-4000-8000-000000000002"), BeaconRules.contentCharacteristic(0));
        assertEquals(UUID.fromString("4c454448-1000-4000-8000-000000000010"), BeaconRules.contentCharacteristic(1));
        assertEquals(UUID.fromString("4c454448-1000-4000-8000-000000000014"), BeaconRules.contentCharacteristic(5));
        Set<UUID> unique = new HashSet<>();
        for (int i = 0; i < BeaconRules.CONTENT_VALUE_COUNT; i++) unique.add(BeaconRules.contentCharacteristic(i));
        assertEquals(BeaconRules.CONTENT_VALUE_COUNT, unique.size());
    }

    @Test
    public void requiresAnEightByteHeaderAndBoundsTextValues() {
        assertTrue(BeaconRules.isValidContentValue(0, 8));
        assertFalse(BeaconRules.isValidContentValue(0, 7));
        assertFalse(BeaconRules.isValidContentValue(0, 9));
        assertTrue(BeaconRules.isValidContentValue(1, 0));
        assertTrue(BeaconRules.isValidContentValue(5, 512));
        assertFalse(BeaconRules.isValidContentValue(5, 513));
    }

    @Test
    public void encodesTheUserNameWithTheLhPrefix() {
        assertArrayEquals(new byte[] { 'L', 'H', 'A', 'n', 'n', 'a' }, BeaconRules.nameScanPayload("  Anna "));
    }

    @Test
    public void omitsBlankNames() {
        assertNull(BeaconRules.nameScanPayload(null));
        assertNull(BeaconRules.nameScanPayload(""));
        assertNull(BeaconRules.nameScanPayload("   "));
    }

    @Test
    public void truncatesNamesToTwentyUtf8Bytes() {
        byte[] payload = BeaconRules.nameScanPayload("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
        assertEquals(2 + BeaconRules.NAME_MAX_BYTES, payload.length);
        assertEquals("ABCDEFGHIJKLMNOPQRST", new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8));
        byte[] umlauts = BeaconRules.nameScanPayload("Jürgen Müller-Lüdenscheid");
        assertEquals(2 + BeaconRules.NAME_MAX_BYTES, umlauts.length);
    }

    @Test
    public void validatesReadOffsets() {
        assertTrue(BeaconRules.isValidReadOffset(10, 0));
        assertTrue(BeaconRules.isValidReadOffset(10, 10));
        assertFalse(BeaconRules.isValidReadOffset(10, 11));
        assertFalse(BeaconRules.isValidReadOffset(10, -1));
    }

    @Test
    public void slicesReadsToTheNegotiatedMtu() {
        assertEquals(22, BeaconRules.readEnd(100, 0, BeaconRules.DEFAULT_ATT_MTU));
        assertEquals(44, BeaconRules.readEnd(100, 22, BeaconRules.DEFAULT_ATT_MTU));
        assertEquals(100, BeaconRules.readEnd(100, 90, BeaconRules.DEFAULT_ATT_MTU));
        assertEquals(100, BeaconRules.readEnd(100, 0, 247));
        assertEquals(0, BeaconRules.readEnd(0, 0, 247));
    }

    @Test
    public void acceptsOnlySingleInboxWritesWithinLimits() {
        byte[] ok = new byte[512];
        assertTrue(BeaconRules.isAcceptedShareWrite(true, false, 0, ok));
        assertFalse(BeaconRules.isAcceptedShareWrite(false, false, 0, ok));
        assertFalse(BeaconRules.isAcceptedShareWrite(true, true, 0, ok));
        assertFalse(BeaconRules.isAcceptedShareWrite(true, false, 1, ok));
        assertFalse(BeaconRules.isAcceptedShareWrite(true, false, 0, null));
        assertFalse(BeaconRules.isAcceptedShareWrite(true, false, 0, new byte[513]));
    }

    @Test
    public void computesSensorMagnitude() {
        assertEquals(5.0, BeaconRules.magnitude(3, 4, 0), 1e-9);
        assertEquals(0.0, BeaconRules.magnitude(0, 0, 0), 0);
    }

    @Test
    public void throttlesMotionSamplesToTenPerSecond() {
        assertTrue(BeaconRules.isMotionSampleDue(100_000_000L, 0));
        assertFalse(BeaconRules.isMotionSampleDue(199_999_999L, 100_000_000L));
        assertTrue(BeaconRules.isMotionSampleDue(200_000_000L, 100_000_000L));
    }

    @Test
    public void dropsStaleGyroscopeReadings() {
        assertEquals(1.5, BeaconRules.recentRotation(1_250_000_000L, 1_000_000_000L, 1.5), 0);
        assertEquals(0.0, BeaconRules.recentRotation(1_250_000_001L, 1_000_000_000L, 1.5), 0);
    }
}
