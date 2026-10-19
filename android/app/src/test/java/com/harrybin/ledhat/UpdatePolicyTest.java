package com.harrybin.ledhat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;

import org.junit.Test;

public class UpdatePolicyTest {
    private static final String PREFIX = UpdatePolicy.HOST_PREFIX + "v1.2.3/";
    private static final String APK = "led-hat-v1.2.3-android.apk";
    private static final String HASH = repeat('a', 64);

    private static String repeat(char c, int count) {
        char[] chars = new char[count];
        Arrays.fill(chars, c);
        return new String(chars);
    }

    @Test
    public void acceptsReleaseAssetsFromThisRepository() {
        assertTrue(UpdatePolicy.isTrustedRequest(PREFIX + APK, PREFIX + "SHA256SUMS.txt", APK));
    }

    @Test
    public void rejectsMissingArguments() {
        assertFalse(UpdatePolicy.isTrustedRequest(null, PREFIX + "SHA256SUMS.txt", APK));
        assertFalse(UpdatePolicy.isTrustedRequest(PREFIX + APK, null, APK));
        assertFalse(UpdatePolicy.isTrustedRequest(PREFIX + APK, PREFIX + "SHA256SUMS.txt", null));
    }

    @Test
    public void rejectsForeignHostsAndInsecureUrls() {
        assertFalse(UpdatePolicy.isTrustedRequest("https://evil.example/" + APK, PREFIX + "SHA256SUMS.txt", APK));
        assertFalse(UpdatePolicy.isTrustedRequest(PREFIX + APK, "https://evil.example/SHA256SUMS.txt", APK));
        assertFalse(UpdatePolicy.isTrustedRequest(PREFIX.replace("https:", "http:") + APK, PREFIX + "SHA256SUMS.txt", APK));
        assertFalse(UpdatePolicy.isTrustedRequest(
            "https://github.com/someone-else/iledcolor-app-native-added/releases/download/v1/" + APK, PREFIX + "SUMS", APK));
    }

    @Test
    public void rejectsUnexpectedFileNames() {
        for (String name : new String[] {
            "led-hat-v1.2-android.apk", "led-hat-v1.2.3-ios.ipa", "../led-hat-v1.2.3-android.apk",
            "led-hat-v1.2.3-android.apk.exe", "other-v1.2.3-android.apk", "" }) {
            assertFalse(name, UpdatePolicy.isTrustedRequest(PREFIX + name, PREFIX + "SUMS", name));
        }
    }

    @Test
    public void parsesChecksumForTheRequestedFile() throws IOException {
        String text = repeat('b', 64) + "  led-hat-v1.2.3-ios.ipa\r\n" + HASH.toUpperCase(Locale.ROOT) + "  " + APK + "\n";
        assertEquals(HASH, UpdatePolicy.parseChecksum(text, APK));
    }

    @Test
    public void parsesBinaryModeMarkerAndSurroundingWhitespace() throws IOException {
        assertEquals(HASH, UpdatePolicy.parseChecksum("   " + HASH + " *" + APK + "   \n", APK));
    }

    @Test
    public void rejectsMissingOrMalformedChecksums() {
        assertThrows(IOException.class, () -> UpdatePolicy.parseChecksum("", APK));
        assertThrows(IOException.class, () -> UpdatePolicy.parseChecksum(HASH + "  other.apk", APK));
        assertThrows(IOException.class, () -> UpdatePolicy.parseChecksum("abc  " + APK, APK));
        assertThrows(IOException.class, () -> UpdatePolicy.parseChecksum(repeat('z', 64) + "  " + APK, APK));
        assertThrows(IOException.class, () -> UpdatePolicy.parseChecksum(HASH + "  " + APK + ".old", APK));
    }

    @Test
    public void hashesStreamsAsLowerCaseHex() throws Exception {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            UpdatePolicy.sha256Hex(new ByteArrayInputStream(new byte[0])));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            UpdatePolicy.sha256Hex(new ByteArrayInputStream("abc".getBytes(StandardCharsets.US_ASCII))));
    }

    @Test
    public void hashesInputsSpanningSeveralReadBuffers() throws Exception {
        byte[] big = new byte[200 * 1024 + 7];
        for (int i = 0; i < big.length; i++) big[i] = (byte) (i * 31);
        StringBuilder expected = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(big)) expected.append(String.format(Locale.ROOT, "%02x", b));
        assertEquals(expected.toString(), UpdatePolicy.sha256Hex(new ByteArrayInputStream(big)));
    }

    @Test
    public void onlyAcceptsStrictlyNewerVersions() {
        assertTrue(UpdatePolicy.isNewerVersion(2004, 2003));
        assertFalse(UpdatePolicy.isNewerVersion(2003, 2003));
        assertFalse(UpdatePolicy.isNewerVersion(2002, 2003));
    }
}
