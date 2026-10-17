# Install and run

```
npm install
npm test            # encoder, controller, storage unit tests
npm run e2e         # Playwright against the production build, mocked hat
npm run build       # static site in dist/
```

## Deploy

Serve `dist/` from any static **HTTPS** origin (GitHub Pages, own host). Paths are relative, so
subdirectory hosting works. Web Bluetooth does not work over `file://` or plain `http://192.168.x.x`.

The GitHub Pages workflow always runs tests, builds the site, and uploads the `github-pages`
artifact. Deployment is opt-in:

1. In repository **Settings → Pages**, select **GitHub Actions** as the build and deployment source.
2. In **Settings → Secrets and variables → Actions → Variables**, create the repository variable
   `PAGES_ENABLED` with the value `true`.
3. Push to `main` or run **Actions → Build and deploy to GitHub Pages → Run workflow**.

Without that variable, the deployment job is skipped; builds do not require an enabled Pages site.
Enable Pages before setting the variable: the default workflow token cannot enable a missing site.

## Install on Android

1. Open the HTTPS URL in Chrome on the phone, wait for "Ready for offline use".
2. Tap **Install app** (or Chrome menu → Install app / Add to Home screen).
3. Later launches work with Wi-Fi/data off; only Bluetooth is needed.

Updates appear as a banner and are applied only when you tap Update (never during a transfer).

## Native apps (Android APK, iOS)

The same web code is wrapped with [Capacitor](https://capacitorjs.com) (`android/`, `ios/`). The
native apps use native BLE (`@capacitor-community/bluetooth-le`) and add **Approach mode**
(see `docs/approaching-mode.md`).

For ready-built signed APK/IPA downloads, see [GitHub Releases](https://github.com/harrybin/iledcolor-app-native-added/releases)
and the [release/signing guide in the README](../README.md#download-android-and-ios-releases).
Android releases do not require iOS signing credentials. The optional iOS download is included
when all Apple signing secrets are configured; it is Ad Hoc and only supports devices registered
in its provisioning profile.

Requirements: Node 22+, JDK 21, Android SDK (platform 36, build-tools 35). Set `JAVA_HOME` and
`ANDROID_HOME` (or put `sdk.dir=...` in `android/local.properties`).

```powershell
npm run android:apk       # debug APK: android\app\build\outputs\apk\debug\app-debug.apk
npm run android:release   # signed APK (with signing configured): android\app\build\outputs\apk\release\app-release.apk
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

For local release signing, create `android/keystore.properties` (gitignored) with
`storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. The CI workflow supplies credentials
through environment variables instead. Without signing configuration, local builds produce
`app-release-unsigned.apk`, which is not installable until signed. To install a signed APK manually, copy it to
the phone and allow "install unknown apps" for the file manager. On first use, Android asks for
**Nearby devices** and **Location** permission (needed for BLE scanning).

**iOS** needs macOS with Xcode 26+: `npm run ios:open`, select a team under *Signing & Capabilities*,
and run it on a device (Bluetooth does not work in the simulator). Use Product > Archive for an IPA
or TestFlight build.

## First use on the hat

Read `docs/compatibility-report.md` and complete it before relying on the app. Connect your cap
on **Connect**, then open **Settings** (the rightmost gear). Start at a dim level in **Display**,
expand **Test patterns (dim, static)** to use **Corner test**, and fix orientation in **Device settings**.
Create, preview and send regular content below the connection controls on **Connect**.

Mock mode for development: open `/#mock`.

## Attribution

Protocol logic is ported from zagi/iledcolor_small (MIT, pinned at
`f68cb027c9f196dc4cb81fa8b39c8aaec97e737a`); license in `third_party/`. The text font is
Press Start 2P (OFL) via `@fontsource/press-start-2p`.
