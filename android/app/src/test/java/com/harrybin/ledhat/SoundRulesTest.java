package com.harrybin.ledhat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

public class SoundRulesTest {
    @Test
    public void supportsOnlyEnglishAndGermanLanguageTags() {
        assertTrue(SoundRules.isSupportedLanguage("en-US"));
        assertTrue(SoundRules.isSupportedLanguage("de-DE"));
        assertFalse(SoundRules.isSupportedLanguage("en-GB"));
        assertFalse(SoundRules.isSupportedLanguage("de"));
        assertFalse(SoundRules.isSupportedLanguage("EN-US"));
        assertFalse(SoundRules.isSupportedLanguage(null));
    }

    @Test
    public void detectsInstalledRecognizerLanguagesByTagOrBaseLanguage() {
        assertTrue(SoundRules.isLanguageInstalled("en-US", Arrays.asList("fr-FR", "en-us")));
        assertTrue(SoundRules.isLanguageInstalled("de-DE", Collections.singletonList("DE")));
        assertFalse(SoundRules.isLanguageInstalled("de-DE", Arrays.asList("de-AT", "en-US")));
        assertFalse(SoundRules.isLanguageInstalled("en-US", Collections.<String>emptyList()));
        assertFalse(SoundRules.isLanguageInstalled("en-US", null));
        assertFalse(SoundRules.isLanguageInstalled(null, Collections.singletonList("en")));
    }

    @Test
    public void encodesSamplesAsLittleEndianPcm16() {
        byte[] bytes = SoundRules.toPcm16le(new short[] { 0, 1, -1, 0x1234, Short.MIN_VALUE, Short.MAX_VALUE });
        assertArrayEquals(new byte[] {
            0, 0, 1, 0, (byte) 0xFF, (byte) 0xFF, 0x34, 0x12, 0, (byte) 0x80, (byte) 0xFF, 0x7F
        }, bytes);
        assertEquals(SoundRules.FRAME_SIZE * 2, SoundRules.toPcm16le(new short[SoundRules.FRAME_SIZE]).length);
    }

    @Test
    public void normalizesSamplesIntoTheUnitRange() {
        assertEquals(-1.0, SoundRules.normalize(Short.MIN_VALUE), 0);
        assertEquals(0.0, SoundRules.normalize((short) 0), 0);
        assertEquals(32767 / 32768.0, SoundRules.normalize(Short.MAX_VALUE), 0);
    }

    @Test
    public void framesLastOneHundredTwentyEightMilliseconds() {
        assertEquals(128, SoundRules.FRAME_DURATION_MS);
    }

    @Test
    public void treatsProximityAsNearWithinFiveCentimetresOrTheSensorRange() {
        assertTrue(SoundRules.isNear(0f, 5f));
        assertFalse(SoundRules.isNear(5f, 5f));
        assertTrue(SoundRules.isNear(4.9f, 10f));
        assertFalse(SoundRules.isNear(5f, 10f));
        // Binary sensors report 0 (near) or their maximum range (far).
        assertTrue(SoundRules.isNear(0f, 1f));
        assertFalse(SoundRules.isNear(1f, 1f));
    }
}
