package com.harrybin.ledhat;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Self-update from GitHub Releases: downloads the release APK, verifies it against the published
 * SHA-256 checksum and this app's package, then hands it to the system installer. Android always
 * asks the user to confirm, and only accepts it when it is signed with the same key.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String HOST_PREFIX = "https://github.com/harrybin/iledcolor-app-native-added/releases/download/";
    private static final Pattern FILE_NAME = Pattern.compile("^led-hat-v\\d+\\.\\d+\\.\\d+-android\\.apk$");
    private static final long MAX_APK_BYTES = 200L * 1024 * 1024;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String checksumUrl = call.getString("checksumUrl");
        String fileName = call.getString("fileName");
        if (url == null || checksumUrl == null || fileName == null || !FILE_NAME.matcher(fileName).matches()
            || !url.startsWith(HOST_PREFIX) || !checksumUrl.startsWith(HOST_PREFIX)) {
            call.reject("Refusing an update that is not from this app's GitHub Releases.");
            return;
        }
        executor.execute(() -> {
            try {
                String expected = expectedSha256(checksumUrl, fileName);
                File dir = new File(getContext().getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create the update folder.");
                File apk = new File(dir, fileName);
                if (!apk.isFile() || !expected.equals(sha256(apk))) {
                    clear(dir);
                    download(url, apk);
                    if (!expected.equals(sha256(apk))) {
                        apk.delete();
                        throw new IOException("The download does not match the published SHA-256 checksum.");
                    }
                }
                verifyPackage(apk);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(settings);
                    resolve(call, "permission-required");
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                resolve(call, "installing");
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Update failed.", e);
            }
        });
    }

    @PluginMethod
    public void openInstaller(PluginCall call) {
        call.unavailable("Over-the-air installer links are only used on iOS.");
    }

    private static void resolve(PluginCall call, String status) {
        JSObject result = new JSObject();
        result.put("status", status);
        call.resolve(result);
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true); // GitHub redirects release assets to its HTTPS CDN
        c.setRequestProperty("Accept", "application/octet-stream");
        int code = c.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            c.disconnect();
            throw new IOException("Download failed with HTTP " + code + ".");
        }
        if (!"https".equals(c.getURL().getProtocol())) {
            c.disconnect();
            throw new IOException("Refusing an insecure download.");
        }
        return c;
    }

    private static String expectedSha256(String checksumUrl, String fileName) throws IOException {
        HttpURLConnection c = open(checksumUrl);
        String text;
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > 64 * 1024) throw new IOException("Checksum file is too large.");
            }
            text = new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally { c.disconnect(); }
        for (String line : text.split("\\r?\\n")) {
            String[] parts = line.trim().split("\\s+", 2);
            if (parts.length == 2 && parts[1].replaceFirst("^\\*", "").equals(fileName)
                && parts[0].matches("(?i)[0-9a-f]{64}")) {
                return parts[0].toLowerCase(Locale.ROOT);
            }
        }
        throw new IOException("The release has no checksum for " + fileName + ".");
    }

    private void download(String url, File target) throws IOException {
        HttpURLConnection c = open(url);
        File partial = new File(target.getPath() + ".part");
        try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
            long total = c.getContentLengthLong();
            if (total > MAX_APK_BYTES) throw new IOException("The update is unexpectedly large.");
            byte[] buf = new byte[64 * 1024];
            long received = 0;
            long lastEmit = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                received += n;
                if (received > MAX_APK_BYTES) throw new IOException("The update is unexpectedly large.");
                out.write(buf, 0, n);
                if (received - lastEmit >= 256 * 1024) {
                    lastEmit = received;
                    progress(received, total);
                }
            }
            progress(received, total);
        } catch (IOException e) {
            partial.delete();
            throw e;
        } finally { c.disconnect(); }
        if (!partial.renameTo(target)) {
            partial.delete();
            throw new IOException("Cannot store the downloaded update.");
        }
    }

    private void progress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", Math.max(total, 0));
        notifyListeners("downloadProgress", p);
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) digest.update(buf, 0, n);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    @SuppressWarnings("deprecation")
    private void verifyPackage(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getPath(), 0);
        if (archive == null || !getContext().getPackageName().equals(archive.packageName)) {
            throw new IOException("The download is not an LED Hat app package.");
        }
        PackageInfo installed = pm.getPackageInfo(getContext().getPackageName(), 0);
        long archiveCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? archive.getLongVersionCode() : archive.versionCode;
        long installedCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? installed.getLongVersionCode() : installed.versionCode;
        if (archiveCode <= installedCode) throw new IOException("The downloaded version is not newer than the installed app.");
    }

    private static void clear(File dir) {
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
    }
}
