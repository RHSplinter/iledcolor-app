# LED Hat Controller - Android, iOS and Web

## App navigation

The native apps have four icon tabs: **Connect**, **Approach**, **Scan**, and
**Settings** (the gear icon at the far right). The web app has **Connect**, **Scan**
and **Settings**; native-only Approach detection is not offered in the browser.
The same source supplies the content editor, scan-first layout, settings, accessible
tab navigation and responsive controls on Android, iOS and web.

- **Connect:** connect/disconnect your primary cap, then create text, solid colours,
  images or GIFs, preview and send them, or save a content preset. There is no separate Create tab.
- **Approach:** configure greetings and group content, compare nearby texts, calibrate
  detection and record/replay walks. Every spanning **Marquee** choice is marked **unstable**:
  physical cap ordering and playback synchronization are not guaranteed. Individual greetings remain available.
- **Scan:** the scan/stop/end-greeting actions, camera and status come first, followed by
  the profile selector, QR profile editor, greeting settings, manual entry, and scan-log/privacy controls.
- **Settings:** saved presets and category-based sharing/import, then display brightness/on/off,
  expandable test patterns and protocol log, and rotation/mirroring/transport settings.
  Loading a content preset opens Connect; loading a group preset opens Approach.

The UI retains its dark theme and blue accent, with larger touch targets, visible keyboard
focus, arrow/Home/End tab navigation, a non-colour selected-tab marker, responsive form
grids and wrapping long preset names. Diagnostics are expandable, not removed.
Existing stored content, settings, QR profiles, backup formats and BLE preset sharing are preserved.
See [the UI change record](docs/ui-improvements.md) for the expert review and implementation details.

## Native apps and approach mode

Besides the PWA, the project builds **Android** and **iOS** apps (Capacitor, `android/` and `ios/`) with the shared UI plus **Approach mode**: when caps come close, they show greetings for each other or one marquee spanning all caps, configurable for 1, 2, up to 4, up to 8, and more than 8 caps. While approach mode runs, presets can also be shared with a nearby phone; the receiver must accept the preset before it is transferred. See [docs/approaching-mode.md](docs/approaching-mode.md) for the detection design and [docs/INSTALL.md](docs/INSTALL.md) for building the APK.

Web Bluetooth requires a supported browser (for example Chrome on Android or desktop);
Safari on iOS does not support it. Offline editing, presets, QR profiles, manual QR entry
and backup/import remain available without Bluetooth. Camera scanning requires HTTPS
and permission. Imported native group presets are retained and can be exported again,
but cannot be loaded in the browser. Nearby BLE sharing is native-only; JSON file
sharing/download remains available on web. The `#mock` development mode deliberately
keeps all four tabs for simulated Approach scenarios.

### App icons

The PWA keeps its original six-colour LED grid. Android and iOS use a distinct blue cap
silhouette containing those same LEDs, on an opaque dark background. Android includes
legacy, round and transparent adaptive foreground variants at all five densities;
iOS uses a 1024 px RGB icon without an alpha channel or baked-in rounded outer corners.
Adaptive launcher artwork fits Android's safe circle.

The vector reference is [`assets/native-icon.svg`](assets/native-icon.svg).
Regenerate both web and native icon assets, then verify their dimensions and safe zones:

```powershell
npm run icons
npm run test:icons
```

For native UI changes, rebuild from `src/` and synchronize both platforms rather than
editing generated assets:

```powershell
npm run cap:sync
```

The iOS release workflow also builds the shared web UI and synchronizes it before
archiving. Compiling/signing iOS requires macOS/Xcode and the signing setup below;
web previews are not evidence of native Bluetooth or camera behaviour.

Approach mode uses phone accelerometer/gyroscope data to support RSSI filtering, with RSSI-only fallback
when sensors are unavailable. These sensors cannot locate other caps, so physical marquee ordering still
uses manual local cap order and deterministic phone-ID order across phones.

In **Settings → Backup**, choose what to include before tapping **Share presets**:
**Creations** (saved text, colors, images and GIFs), **Approach settings** (saved group presets
and current group content), and **Scan settings** (proximity thresholds, timing and QR greeting profiles).
The system share sheet sends a JSON file. Import replaces only the included categories,
keeping excluded presets, phone identity, cap connections and device settings unchanged.
Older full JSON backups remain importable with their original full-replacement behavior.

## QR badge greetings

The **Scan** tab scans QR codes locally using the camera (Android/iOS app or an HTTPS
browser with camera permission). Only the primary cap connected to the scanning phone
is interrupted; other connected caps continue unchanged. The camera stops after one
successful scan, on Stop, on changing tabs, or when the app is hidden.

Configure a greeting such as `Hi {name}!`, its scroll speed, and the repetition count
(**3 by default**). A name is extracted automatically from plain text, JSON name fields,
or a vCard. Save up to **three QR profiles** locally, each with a regex, greeting template,
and note; **None** selects the general plain-text/JSON/vCard parser. For other badge formats,
enter a JavaScript regex **without `/` delimiters**. Its first three capture groups map to
`{name}`/`{firstname}`, `{lastname}`, and `{company}`; named groups
`(?<name>...)`/`(?<firstname>...)`, `(?<lastname>...)`, and `(?<company>...)` are also supported.
For example, the MS AI Tour badge format
`^[^^]*\^(?<firstname>[^^]+)\^(?<lastname>[^^]+)\^(?<company>[^^]+)\^` extracts the
three fields. `Hello {firstname} {lastname} from {company}!` uses them in a greeting.
Without capture groups, a named `name` group or the whole match supplies `{name}`.
Matches are not URL-decoded.
Unmatched/invalid patterns show an error without changing the cap. Regex extraction
runs in a worker with a timeout so a pathological pattern cannot block the UI.
Manual QR-data entry is available when a camera cannot be used.

Send content to the cap once before scanning: the protocol cannot read back content
that was installed by another app or before the current connection. The app retains the
last successfully sent image or GIF, including content sent by Approach mode. The greeting
always scrolls, even when it would fit as static text. It uses a finite-loop GIF and the
GIF's actual frame timings to restore the previous content after the requested count.
Approach updates for the primary cap wait during the greeting; afterwards the current
approach plan resumes (with span timing resynchronized). Other caps are not paused.
**End greeting** restores content early. Connection loss is reported instead of claiming
restoration; reconnect and send the desired content again.
If this connection explicitly switched the display off, the greeting briefly switches it
on and restores the off state. Brightness is left unchanged.

Keep the app open through playback and restoration: phones can suspend JavaScript in the
background, delaying restoration, and a closed app cannot restore a disconnected cap.
Finite GIF-loop handling and precise physical playback timing still need verification on
the actual cap firmware; BLE acknowledgements confirm transfer, not displayed frame counts.
Scanner configuration stays in local storage; QR payloads are not persisted unless you
enable **Save all scanned data to a local file** in the Scan tab (off by default).
While enabled, every camera scan or submitted manual entry is appended before extraction,
including entries whose greeting fails. The local `qr-scan-log.jsonl` file contains one JSON
object per line with a UTC timestamp, source (`camera`/`manual`), the complete unmodified
payload (`raw`), and the selected profile's ID/note (or `null`). JSON escaping preserves
embedded line breaks. Logging stays enabled across restarts until switched off; disabling
it keeps the existing log. Logs may contain personal data: obtain appropriate consent and
share only with trusted recipients.
**Share scan log** opens the native share sheet, or shares/downloads the file in supported
browsers. Native logs live in the app's private data directory; a share snapshot is written
to cache. Browser logs use local IndexedDB via Capacitor Filesystem and may be evicted by
the browser. Uninstalling the app or clearing its data removes logs; share them for safekeeping.
The app does not upload scans to a server. Logs are excluded from preset backups.
The QR profiles are included in the existing JSON preset
backup/import. The resulting greeting is sent to the cap over BLE.

Credits: inspired by **Rob Bos / Xebia's [badge-scanner](https://github.com/xebia/badge-scanner)**.
No code was copied from that repository, which had no declared license when inspected.
The independent scanner bundles **ZXing Browser (MIT)** and **ZXing JS (Apache-2.0)**;
credits and full licenses are shipped in `public/licenses/` and linked in the Scan tab.
The decoder is bundled locally, not loaded from a CDN, and is cached for offline use.
No native scanner plugin or Android minimum-SDK increase is required.

## Download Android and iOS releases

Download published builds from [GitHub Releases](https://github.com/harrybin/iledcolor-app-native-added/releases):

| Asset | Installation |
| --- | --- |
| `led-hat-vX.Y.Z-android.apk` | Signed release APK. Download on Android and allow installation from that download source. Updates require the same signing key. |
| `led-hat-vX.Y.Z-ios.ipa` (currently disabled) | Signed **Ad Hoc** IPA, added only by a manual iOS workflow run with all iOS signing secrets configured. Install with Apple Configurator on macOS or Xcode's Devices and Simulators window. Only iPhones/iPads whose UDIDs are registered in the embedded provisioning profile can install it. |
| `SHA256SUMS-android.txt` / `SHA256SUMS-ios.txt` | SHA-256 checksums, uploaded independently for each platform. |

An IPA downloaded from GitHub is **not** unrestricted iOS distribution: an active Apple Developer
Program membership, a valid distribution certificate, and an Ad Hoc profile for
`com.harrybin.ledhat` with the target devices are required. Adding devices requires a new profile
and a new release. Certificate/profile expiry also limits installation/use. App Store and
TestFlight distribution are not part of this workflow. BLE needs a physical device.
The IPA embeds the provisioning profile, including registered device UDIDs; anyone with download
access can inspect it. Account for this before publishing Ad Hoc builds in a public repository.

### One-time signing setup

In **Settings > Secrets and variables > Actions**, add the four Android repository secrets before
the first Android release. The three iOS secrets are optional: until all three are present, the
iOS workflow skips its native build and publication, with an explicit notice in its summary.
The independent Android workflow needs no Apple credentials.

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 of the release JKS/keystore containing the private signing key. Reuse an existing app's key for updates. |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password. |
| `ANDROID_KEY_ALIAS` | Signing-key alias. |
| `ANDROID_KEY_PASSWORD` | Private-key password. |
| `IOS_CERTIFICATE_BASE64` | Base64 of a password-protected `.p12` export containing one valid **Apple Distribution** certificate and its private key. |
| `IOS_CERTIFICATE_PASSWORD` | Password of the `.p12` export (must not be empty). |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of an **Ad Hoc distribution** `.mobileprovision` for this app, matching the certificate and containing the intended device UDIDs. |

Use standard Base64 (not Base64URL). Encode the complete binary files locally; never commit keys,
profiles, passwords, or Base64 values. Keep a secure backup of the Android key: replacing it
prevents upgrades over existing installations. The iOS team and profile UUID are read from the
profile automatically. Signing material is installed temporarily on the runner and removed after
the build, including on failure. Missing Android secrets or invalid signing material fail the build;
there is no debug-signed or unsigned fallback. Once all iOS secrets are present, a (manual) iOS
run builds iOS. A failed build/signing step blocks only that platform's upload, never the other
platform's build or publication.

> **iOS is currently disabled for automatic releases.** The iOS workflow does not run on pushed
> tags, so tag pushes build and publish only Android. It can still be started manually via
> **Run workflow**. To re-enable it, add the three iOS secrets and restore the
> `push: tags: ['v*']` trigger in [release-ios.yml](.github/workflows/release-ios.yml).

GitHub Actions must be enabled, and repository/organization policy must allow the publishing job's
`contents: write` permission for `GITHUB_TOKEN`. No personal access token is needed.

### Versioning and publishing

`package.json` is the version source (currently **0.2.2**), with `package-lock.json` kept in sync.
The npm `version` hook updates Android's `versionName` and iOS's `MARKETING_VERSION`, plus both
native build numbers. Only stable `MAJOR.MINOR.PATCH` versions are supported (no prerelease/build
suffixes). The build number is `MAJOR * 1000000 + MINOR * 1000 + PATCH + 1`: `0.2.0` becomes
`2001`. Minor and patch are limited to 999 and the build number to 2100000000. Always increase
the version; reusing a tag/build number is not a new release.

For example, prepare the next patch from the repository root on Windows:

```powershell
npm version patch --no-git-tag-version
npm run version:check
npm run test:release
git add package.json package-lock.json android\app\build.gradle ios\App\App.xcodeproj\project.pbxproj
git commit -m "chore: release 0.2.1"
git tag v0.2.1
git push origin HEAD
git push origin v0.2.1
```

The example assumes the current version is `0.2.0`; use the resulting version for the commit/tag.
Use `minor` or `major` instead of `patch` for larger changes. To publish the initial `0.1.0`,
commit the workflows and synchronized version files first, then tag that commit `v0.1.0`.
If versions were edited manually, run `npm run version` to synchronize native metadata.

[Build Android release](.github/workflows/release-android.yml) and
[Build iOS release](.github/workflows/release-ios.yml) are separate workflows. The Android workflow
is triggered by pushed `v*` tags; the iOS workflow is currently manual-only (see above). Each checks that the tag, npm manifests, and native metadata agree, runs the tests,
builds its own copy of the shared web app, and builds its signed native package (Linux/JDK 21 for
Android, macOS/Xcode 26 for iOS). Builds run independently and can run in parallel.

Each successful workflow creates or extends the **same GitHub Release** for that tag with its own
package and checksum file. Android is published immediately after its own build succeeds, even
when iOS is disabled, skipped, still running, or failing; iOS can add its download later. Only the short
publishing jobs share a per-tag concurrency lock to avoid races when creating the release.
The existing GitHub Pages workflow is unchanged.

You can also start **Actions > Build Android release / Build iOS release > Run workflow** with
an existing version tag, for example after correcting signing secrets. Android accepts either
`0.1.0` or `v0.1.0` and resolves both to the existing `v0.1.0` tag; iOS requires the full
`v0.1.0` tag. Neither workflow creates tags. For the initial release,
create and push `v0.1.0` from the prepared release commit first:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Pushing the tag starts the Android build automatically; a manual run is only needed to rebuild it.
Selecting a branch in **Run workflow** does not replace the required tag.
Use **Re-run failed jobs**
for transient failures. Retrying a workflow replaces only its own platform's package and checksum
file, leaving the other platform's downloads intact. New app versions must still use a new version
and tag. A newly created draft is published after that platform's upload succeeds; the other
platform does not need to finish first.
Build artifacts remain available in Actions for seven days; the GitHub Release assets are the
persistent downloads. Neither workflow generates version-bump commits or pushes tags itself.

## Project Description

Build a local-first webapp that installs on an Android home screen and controls the hat's LED display directly over Bluetooth Low Energy (BLE). Text, colors, images, and saved presets stay on the phone. No account, vendor app, backend, or internet connection is required during normal use.

Use [zagi/iledcolor_small][reference] as the connection and protocol reference, porting its relevant Python logic to TypeScript rather than running Python on Android.

**Target hardware:** [the supplied Amazon hat][hat], whose link resolves to ASIN `B0BZD3W1XY`. The accessible listing did not establish its companion app, BLE protocol, or display dimensions. Do not assume compatibility from appearance or from listings for other hats.

**Working assumptions**

- "Downloaded on Android" means an installable Progressive Web App (PWA), not initially a downloadable APK.
- "Local" means rendering, storage, and Bluetooth control happen on the phone. A static HTTPS site provides initial installation and optional updates; it is not a control server.
- Treat the LEDs as a pixel matrix until hardware inspection establishes otherwise. A linear LED strip or a controller using another protocol needs a different device profile.
- Support current stable Chrome on Android first. Other browsers, APK packaging, and additional hat protocols are separate compatibility work.

## End Goal

An installed app that can open offline, connect to the verified hat, preview content, upload it, adjust brightness, and switch the display on or off.

The MVP includes connection status, static text, solid colors, local PNG/JPEG import, a pixel preview, and named presets with JSON export/import. Scrolling text and animated GIF upload follow only after the static-image path works.

Success requires a physical test on this exact hat. The reference repository establishes a plausible implementation path, not proof that the Amazon product supports it.

## Implementation

### 1. Confirm the hat before building the full app

**First milestone: a compatibility report and one successful image upload.**

1. Read the box/manual QR code and record the actual companion app, hardware label, and any stated resolution.
2. Power on the hat, close other controller apps, and use nRF Connect on Android to inspect its advertised name, service UUIDs, and characteristic properties. Inspection is read-only initially.
3. Compare the result with the reference driver's GATT profile:

   | Purpose | Full UUID | Required property |
   |---|---|---|
   | Main service | `0000a950-0000-1000-8000-00805f9b34fb` | Primary service |
   | Commands | `0000a951-0000-1000-8000-00805f9b34fb` | Write without response |
   | Stream data | `0000a952-0000-1000-8000-00805f9b34fb` | Write without response |
   | Acknowledgements | `0000a953-0000-1000-8000-00805f9b34fb` | Notify |

4. The reference panel advertises as `iledcolor-*`; its discovery advertisement may include `0xAF30` rather than the actual `0xA950` GATT service. Do not require advertised `0xA950` to discover it.
5. If the profile matches, run a minimal Android browser connection spike: subscribe to notifications, handshake, then upload a dim, static color test. Confirm dimensions, orientation, and RGB order using an asymmetric corner pattern. The reference's validated panel is 16 x 32 portrait; that is not an established hat specification.
6. Optionally use the reference Python CLI on a BLE-capable computer as a diagnostic comparison. A desktop success does not replace the Android test.
7. Record the verified profile, command responses, usable write sizes, firmware identifiers if available, and whether content persists after disconnect and power cycling.

**Go/no-go:** proceed with the iLEDColor implementation only after the exact hat accepts the handshake and renders the test correctly. A matching name alone is insufficient.

If the hat exposes another protocol, stop iLEDColor writes. Identify its actual companion protocol and create a separate, documented adapter using authorized captures of the owner's device. If it uses Bluetooth Classic rather than BLE GATT, Web Bluetooth is not the appropriate transport. A native Android implementation would then require separate evaluation; an APK wrapper alone will not translate the protocol.

### 2. App architecture and installation

Use **Vite + TypeScript**, a small mobile-first interface, Canvas for rendering, IndexedDB for presets, and a PWA service worker. Avoid a server and unnecessary framework layers.

```text
Installed Android PWA
  UI and pixel preview
    -> local text/image renderer
    -> iLEDColor binary encoder
    -> serialized transfer controller
    -> Web Bluetooth -> hat
  IndexedDB <- presets, artwork, verified device profile
  Service worker <- cached app shell, fonts, icons, bundled libraries
```

Keep the encoder independent of the browser and keep BLE calls behind a small transport interface. This permits deterministic tests and, if necessary later, a native transport without rewriting rendering or packet generation.

**Installation path**

1. Publish the production static build at a stable HTTPS origin, such as GitHub Pages or a self-hosted HTTPS site. Set asset paths, manifest scope, and service-worker scope correctly for subdirectory hosting.
2. Provide a manifest with app identity, `start_url`, `scope`, standalone display, theme colors, and suitable 192/512-pixel and maskable icons.
3. Cache every runtime dependency locally. Do not load fonts, scripts, artwork, or encoders from a CDN at runtime.
4. Open the URL in Chrome on Android and use its Install/Add to Home Screen action. Offer an in-app installation button when the browser exposes the installation event; otherwise show browser-menu instructions.
5. Show "Ready for offline use" only after required assets are cached successfully. Keep a working cache until its replacement is complete; offer updates when idle, never reload during a transfer.

Web Bluetooth requires a secure context and a user gesture for the device chooser. Opening downloaded HTML through `file://`, or serving the app from `http://192.168.x.x`, is not the deployment plan. A computer's `localhost` is also not the phone's `localhost`. Local-network hosting needs HTTPS trusted by the phone.

Initial installation and updates may need network access; daily use must not. Bluetooth work runs in the foreground page, not in the service worker. Do not promise continuous transfers while Android locks or suspends the app.

**Optional APK:** if a sideloadable file becomes a requirement, package the shared web UI with Capacitor and a maintained native BLE plugin, build a signed APK, and document installation and signing-key/update management. Implement Android-version-appropriate Bluetooth permissions. Do not assume Web Bluetooth works inside Android WebView. An APK is not needed for the PWA MVP.

### 3. Implement the connection lifecycle

On an explicit **Connect** tap:

1. Check secure-context status and availability of `navigator.bluetooth`; explain unsupported browsers or disabled/unavailable Bluetooth.
2. Call `requestDevice` with the verified advertised name/prefix and `optionalServices: [A950_UUID]`. For the reference profile, use `namePrefix: "iledcolor-"`; do not hardcode a MAC address. Android's browser chooser owns device selection.
3. Connect to GATT and obtain A951, A952, and A953. Confirm the required properties before writing.
4. Register the notification handler and call `startNotifications()` on A953 before sending commands.
5. Write Connect to A951 using `writeValueWithoutResponse`, then validate its acknowledgement.
6. Write the all-zero six-byte TestPass request and validate its acknowledgement. Accept only recognized success/no-password responses established during the spike. The reference comments identify `0x01` as correct, `0x03` as unset, and an observed `0x00` as no-password/OK; `0x02` is denied.
7. Enter Ready only after successful validation. Unknown, malformed, missing, or denied responses are errors, not successful connections. Password changes and guessing are out of scope.

Use a single operation queue and explicit states: Disconnected, Selecting, Connecting, Handshaking, Ready, Uploading, and Error. Do not interleave brightness commands with stream writes. Handle chooser cancellation without presenting it as a device fault.

On `gattserverdisconnected`, cancel outstanding waits and writes, clear stale notifications, and retain unsent artwork. Provide an explicit reconnect action; rediscover characteristics and repeat the handshake after reconnecting. Never silently resume a partially uploaded stream.

### 4. Port the actual wire protocol

Use [`framing.py`][framing], [`transport.py`][transport], [`device.py`][device], and the [framing tests][tests] as the primary implementation references.

**Important source discrepancy:** [`docs/protocol.md`][protocol] retains early, conflicting hypotheses about an 8-bit checksum, AE00 authentication, and chunk headers. The working code/tests use a **16-bit checksum**, a **12-byte Continue overhead**, and an **A950-only handshake**. Do not implement the obsolete AE00 challenge sequence or sum-mod-256 description.

| Element | Required encoding |
|---|---|
| Frame | `0x54`, command byte, 2-byte big-endian length, body, 2-byte big-endian checksum |
| Length field | Body length plus the two checksum bytes |
| Frame checksum | Sum of all preceding frame bytes, wrapping at 16 bits |
| Stream CRC | CRC-32C/Castagnoli, not ordinary CRC-32; computed over metadata plus image/GIF payload |
| Stream wrapper | CRC as 4-byte big-endian, `0x01`, 19 zero bytes, then metadata and payload |
| Image metadata | 22 bytes: eleven big-endian unsigned 16-bit fields; preserve the source's ordering and format-specific defaults |
| Static pixels | Row-major RGB triples, exactly `width * height * 3` bytes |
| Stream commands | StartStream `0x06` on A951; Continue `0x00` and EndStream `0x01` on A952 |
| Continue body | 4-byte big-endian sequence starting at zero, 2-byte big-endian chunk length, chunk bytes |
| Brightness/display | Dimming `0x09` and DisplayEnable `0x0A` on A951 |

Retain these byte-for-byte regression fixtures:

```text
Connect:   540d0003000064
TestPass:  540f0008000000000000006b
EndStream: 54010003010059
StartStream(crc=0x2C785733, length=1582):
           5406000d2c7857330000062e00000001c9
```

A 16 x 32 RGB test stream must contain `24 + 22 + 16 * 32 * 3 = 1582` bytes. Use the measured hat dimensions in production, not this fixture's dimensions.

StartStream has a 16-bit total-length field: reject streams larger than 65,535 bytes, including wrapper and metadata, before writing anything. Firmware may impose a smaller limit; establish and enforce that limit during hardware testing.

Pin the reference commit when implementation starts and preserve its MIT license/attribution for adapted code. Record observed hardware deviations separately rather than changing fixtures to conceal incompatibility.

### 5. Make transfers reliable on Android

The Python driver uses 492-byte chunks, resulting in 504-byte GATT values, with a default 10 ms inter-write delay. Its desktop MTU assumptions are not a guarantee for Android Web Bluetooth, which does not provide portable MTU negotiation/query controls.

- Begin the spike with complete Continue frames no larger than 20 bytes: at most 8 stream bytes plus the 12-byte protocol overhead. This is a conservative BLE starting point, not proof that the hat firmware accepts that chunk size.
- Test larger complete frames on the target phone/hat, for example 244-byte values with 232-byte chunks. Store only a hardware-tested transport profile; do not infer a safe write size from desktop results.
- Never split one encoded protocol frame arbitrarily across GATT writes unless firmware reassembly has been verified.
- Serialize and await writes. Start with the reference's pacing, then tune only from measured acknowledgements and display results.
- Validate acknowledgement magic, exact length, checksum, expected command, and sequence/status where present. Install the pending-response wait before writing so fast notifications are not lost.
- Treat reference timeouts as initial tuning values: 2 seconds for handshake/start, 500 ms per chunk, and 1 second for end. Make timeout/disconnect outcomes visible and never report a successful upload from a resolved write alone.
- On ambiguous completion, stop and show "Upload unconfirmed." Offer a fresh reconnect/full upload. Avoid automatic chunk retries until duplicate-sequence handling is understood.
- Report acknowledged progress and support cancellation between writes. Disconnect on cancellation of a partial upload to avoid leaving a reusable but ambiguous session.

If the firmware demonstrably omits some acknowledgements, document that behavior and distinguish "Sent, not confirmed" from success. Do not copy the Python driver's permissive password check or swallowed timeout behavior into the user-facing status model.

### 6. Rendering and local UX

Provide three primary views: **Connect**, **Create**, and **Presets**, with persistent connection state and an explicit Send button.

- Render text with a bundled pixel font and defined supported glyphs. Show unsupported-character warnings rather than silently dropping characters.
- Render to the verified matrix dimensions; provide measured rotation/mirroring controls and a nearest-neighbor enlarged preview.
- Support solid fills, static text, and PNG/JPEG scaling with fit/fill choices. Composite transparency onto a selected background before producing RGB data.
- Use the system file picker, process files locally, and reject excessive input file sizes or decoded dimensions before expensive rendering. Define and test bounded import limits.
- Store named content presets and device/display settings in IndexedDB. Provide versioned, validated JSON export/import and visible errors for corrupt data or storage exhaustion.
- Offer a brightness control mapped to the observed reference levels: `0` brightest, `10` dimmest. Keep display Off separate; the dimmest level is not documented as fully off. Confirm this mapping on the hat.
- Debounce brightness changes; show pending versus confirmed state. Begin hardware tests at low brightness with static patterns.

For scrolling text, generate a small looping GIF locally and upload it using the reference's GIF metadata profile. Verify the hat supports this mode and plays it after disconnect before exposing it. Enforce frame-count, duration, memory, and final encoded-stream limits. Defer arbitrary GIF import and high-rate live streaming.

Do not add microphone, location collection, cloud artwork storage, telemetry, weather, accounts, or background animation streaming. Any Bluetooth-related OS permission prompts must be explained accurately for the tested Android version.

### 7. Verification and release gates

Use Vitest for the encoder/state machine and Playwright for browser UI/offline tests with a mocked transport. Real Android BLE testing is mandatory; browser mocks cannot establish hardware compatibility.

| Gate | Required evidence |
|---|---|
| Hardware match | Exact hat's services/properties recorded; Android handshake and asymmetric static image succeed |
| Encoder correctness | Golden frames above match; CRC-32C of ASCII `123456789` is `0xE3069283`; 1582-byte fixture passes |
| Input limits | Reject wrong pixel counts, invalid dimensions, unsupported brightness, oversized streams, and malformed imports before BLE writes |
| Notification handling | Reject bad checksum/length, denied password, unexpected command/sequence, and stale replies; no false Ready or success state |
| Transfer lifecycle | Mock early replies, timeouts, cancellation, queue contention, disconnect mid-stream, and reconnect; no overlapping writes |
| Physical rendering | Red/green/blue, corner orientation, static text, brightness levels, display off/on, and presets behave correctly |
| Reliability | 20 consecutive static uploads on each of two available Android phone models pass; measure transfer time and record Android/Chrome versions |
| Offline operation | Install/cache once, close app, disable Wi-Fi/mobile data while leaving Bluetooth on, relaunch from home screen, edit a preset, connect, and upload |
| Interruption recovery | Lock/unlock, range loss, hat power cycle, and another app holding the connection produce an accurate state and recover via explicit reconnect |
| Update/storage safety | Update does not interrupt an upload or erase presets; storage denial/eviction yields visible recovery/export guidance |
| Privacy | With the app cached and updates disabled for the check, control sessions generate no app-initiated network requests and no external content uploads |
| Animation, if shipped | Hat loops uploaded GIF after disconnect; behavior after hat power cycling is recorded, not assumed |

If only one Android phone is available, document that narrower tested support instead of claiming the two-device gate passed.

### 8. Delivery sequence and estimates

Estimates assume one developer, physical access to the hat, and a compatible iLEDColor controller. They are planning ranges, not guarantees.

| Milestone | Deliverable | Estimate |
|---|---|---|
| Compatibility spike | Device profile, verified Android transfer, explicit go/no-go | 1-2 days |
| Protocol and transport | Tested TypeScript encoder, notifications, transfer queue, recovery | 2-3 days |
| MVP UI | Text/colors/images, preview, brightness/display controls, presets | 2-3 days |
| Installation and hardening | Offline PWA, update behavior, device tests, installation guide | 1-2 days |
| Optional animation | Local scrolling-GIF generation and verified native playback | 1-2 days |

Expected compatible-device MVP: **6-10 development days**. A different or encrypted protocol requires a separately scoped discovery phase; these estimates no longer apply.

Deliver the app source, static production build, installation URL/instructions, supported-device profile, protocol fixtures, and a recorded hardware test matrix. Keep APK delivery optional. No hardware modification or replacement firmware is part of this plan.

## References

Sources reviewed on 2026-10-06. Upstream `main` can change; pin it during implementation.

- [Reference repository and supported hardware scope][reference]
- [BLE transport and UUIDs][transport]
- [Device handshake, transfers, timing, and controls][device]
- [Binary framing, CRC-32C, and metadata][framing]
- [Golden protocol tests][tests] and [GIF metadata tests][gif-tests]
- [Reverse-engineered protocol notes; contains superseded hypotheses][protocol]
- [Chrome Web Bluetooth requirements and examples][web-bluetooth]
- [PWA installation behavior][pwa-install]
- [Requested Amazon product][hat]; exact protocol and dimensions remain unverified

[reference]: https://github.com/zagi/iledcolor_small
[hat]: https://amzn.eu/d/0gSz9JeD
[framing]: https://github.com/zagi/iledcolor_small/blob/main/src/iledcolor/framing.py
[transport]: https://github.com/zagi/iledcolor_small/blob/main/src/iledcolor/transport.py
[device]: https://github.com/zagi/iledcolor_small/blob/main/src/iledcolor/device.py
[tests]: https://github.com/zagi/iledcolor_small/blob/main/tests/test_framing.py
[gif-tests]: https://github.com/zagi/iledcolor_small/blob/main/tests/test_framing_gif.py
[protocol]: https://github.com/zagi/iledcolor_small/blob/main/docs/protocol.md
[web-bluetooth]: https://developer.chrome.com/docs/capabilities/bluetooth
[pwa-install]: https://web.dev/learn/pwa/installation
