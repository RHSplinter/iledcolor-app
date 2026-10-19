package com.harrybin.ledhat;

import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.regex.Pattern;

/** Framework-free update rules used by {@link AppUpdaterPlugin}, kept separate so they run in JVM unit tests. */
final class UpdatePolicy {
    static final String HOST_PREFIX = "https://github.com/harrybin/iledcolor-app-native-added/releases/download/";
    static final long MAX_APK_BYTES = 200L * 1024 * 1024;
    static final int MAX_CHECKSUM_BYTES = 64 * 1024;
    private static final Pattern FILE_NAME = Pattern.compile("^led-hat-v\\d+\\.\\d+\\.\\d+-android\\.apk$");

    private UpdatePolicy() {}

    static boolean isTrustedRequest(String url, String checksumUrl, String fileName) {
        return url != null && checksumUrl != null && fileName != null && FILE_NAME.matcher(fileName).matches()
            && url.startsWith(HOST_PREFIX) && checksumUrl.startsWith(HOST_PREFIX);
    }

    /** Finds the lower-case SHA-256 for {@code fileName} in a {@code sha256sum}-style listing. */
    static String parseChecksum(String text, String fileName) throws IOException {
        for (String line : text.split("\\r?\\n")) {
            String[] parts = line.trim().split("\\s+", 2);
            if (parts.length == 2 && parts[1].replaceFirst("^\\*", "").equals(fileName)
                && parts[0].matches("(?i)[0-9a-f]{64}")) {
                return parts[0].toLowerCase(Locale.ROOT);
            }
        }
        throw new IOException("The release has no checksum for " + fileName + ".");
    }

    static String sha256Hex(InputStream in) throws IOException, NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) digest.update(buf, 0, n);
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    static boolean isNewerVersion(long archiveCode, long installedCode) {
        return archiveCode > installedCode;
    }
}
