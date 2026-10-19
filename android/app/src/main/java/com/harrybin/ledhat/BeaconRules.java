package com.harrybin.ledhat;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

/** Framework-free rules used by {@link ApproachBeaconPlugin}, kept separate so they run in JVM unit tests. */
final class BeaconRules {
    static final int CONTENT_VALUE_COUNT = 6;
    static final int MAX_VALUE_BYTES = 512;
    static final int DEFAULT_ATT_MTU = 23;
    /** Mirrors beaconCodec.ts: user name as manufacturer data (test company id) in the scan response. */
    static final int NAME_COMPANY_ID = 0xFFFF;
    static final int NAME_MAX_BYTES = 20;
    private static final byte[] NAME_PREFIX = { 'L', 'H' };
    private static final long MOTION_INTERVAL_NS = 100_000_000L;
    private static final long ROTATION_MAX_AGE_NS = 250_000_000L;

    private BeaconRules() {}

    /** Value 0 is the 8-byte header (…0002); values 1–5 are the shared texts (…0010–…0014). */
    static UUID contentCharacteristic(int index) {
        int suffix = index == 0 ? 2 : 9 + index;
        return UUID.fromString(String.format(Locale.ROOT, "4c454448-1000-4000-8000-%012d", suffix));
    }

    static boolean isValidContentValue(int index, int length) {
        return length <= MAX_VALUE_BYTES && (index != 0 || length == 8);
    }

    /** Returns {@code "LH" + UTF-8 name} truncated to 20 name bytes, or null when the name is blank. */
    static byte[] nameScanPayload(String name) {
        if (name == null || name.trim().isEmpty()) return null;
        byte[] utf8 = name.trim().getBytes(StandardCharsets.UTF_8);
        int len = Math.min(utf8.length, NAME_MAX_BYTES);
        byte[] payload = new byte[NAME_PREFIX.length + len];
        System.arraycopy(NAME_PREFIX, 0, payload, 0, NAME_PREFIX.length);
        System.arraycopy(utf8, 0, payload, NAME_PREFIX.length, len);
        return payload;
    }

    static boolean isValidReadOffset(int length, int offset) {
        return offset >= 0 && offset <= length;
    }

    /** Exclusive end of the slice that fits into one ATT read response for the negotiated MTU. */
    static int readEnd(int length, int offset, int mtu) {
        return Math.min(length, offset + mtu - 1);
    }

    static boolean isAcceptedShareWrite(boolean inbox, boolean preparedWrite, int offset, byte[] value) {
        return inbox && !preparedWrite && offset == 0 && value != null && value.length <= MAX_VALUE_BYTES;
    }

    static double magnitude(float x, float y, float z) {
        return Math.sqrt((double) x * x + (double) y * y + (double) z * z);
    }

    static boolean isMotionSampleDue(long timestamp, long lastEmitted) {
        return timestamp - lastEmitted >= MOTION_INTERVAL_NS;
    }

    static double recentRotation(long timestamp, long rotationTime, double rotation) {
        return timestamp - rotationTime <= ROTATION_MAX_AGE_NS ? rotation : 0;
    }
}
