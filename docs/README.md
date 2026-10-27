# LED Hat Controller - Android, iOS and Web

## App navigation

The web controller has five icon tabs: **Presets**, **Custom**, **Sound**, **Settings**, and **Scan** (the gear icon). Custom uses the drawing/pencil icon. Native apps also retain their existing Approach mode.

The website starts on **LED Hat Connection**. Connect there to select and pair the hat; the controller opens with Presets selected. Keep the connection tab open because it owns the Bluetooth link. **Go to LED Hat Controller** also works without a hat and opens Scan without an automatic pairing attempt.

Without a hat, only **Connect hat** and **Scan** remain visible. The connection screen opens by default; Scan can recognize badges and show results locally. Connect hat opens or focuses the Bluetooth connection tab. After connecting, the full tab bar appears, Custom uses the pencil icon, and Scan is last. On connection success, the controller selects Presets. Refresh reattaches only to an existing live connection tab. If that link fails or is gone, the controller returns to Connect hat, with Scan still available.

**Install app** uses the existing browser installation flow and is available on the connection screen. The installed app uses the same held-link and controller-window flow.

The **Hat connection** section has no Disconnect button. To disconnect a connected cap,
tap the connection status pill at the top and select **Disconnect**.
Tap the pill again, tap elsewhere or press Escape to dismiss the button.
The top status bar shows live pills across every tab for primary cap connection,
with a green link icon when connected (including uploads) and a red broken-link icon otherwise,
**Approach** (`Approach: off`, `Approach: on`, or `Approach: on (N)` with the nearby group count),
**Listening** (`Listening: off`, `Listening: starting…`, `Listening: voice sample`, `Listening: on`,
`Listening: paused`, or `Listening: stopping…`), and offline readiness.
The same source supplies the content editor, scan-first layout, settings, accessible
tab navigation and responsive controls on Android, iOS and web.

- **Custom:** after connecting your primary cap, expand **Text**, **Solid color**,
  **Image**, or **GitHub Contributions** to edit and send content. All sections start
  collapsed with a right-pointing chevron that turns down when expanded. Each has its own **Send to cap** and
  **Save as preset** buttons. Saving reveals a name field and adjacent check button.
  Text supports emoji, automatically scrolls when too wide, and can override the
  Settings font per preset. Images support PNG/JPG/animated GIF and contain/cover/stretch fitting.
  Under **Sequence**, add the current content or saved presets as steps (up to 20), set how
  many seconds each step shows (animations play whole cycles for at least that long), reorder
  or remove steps, and turn on **Play sequence** to preview, send or save all steps as one
  looping animation. Pausing keeps the steps as a draft. Sequence presets can be shared with
  nearby phones running a version that supports sequences. Long holds between GIF frames still
  need verification on the physical hat.
- **Approach:** configure greetings and group content, compare nearby texts, calibrate
  detection and record/replay walks. When approach mode is running and transitions into a
  multi-cap group greeting on a connected cap, the phone vibrates once as the group upload starts.
  Every spanning **Marquee** choice is marked **unstable**:
  physical cap ordering and playback synchronization are not guaranteed. Individual greetings remain available.
- **Scan:** the scan/stop/end-greeting actions, camera and status come first, followed by
  the profile selector, QR profile editor, greeting settings, manual entry, and scan-log/privacy controls.
  A recognized QR greeting (camera or manual entry) vibrates once immediately when the greeting
  starts on the primary cap; stopping the camera or a failure does not vibrate.
- **Sound:** opt-in applause/whistle detection, wearer voice sampling, English/German
  phrase reactions, pocket-pause settings, dictionary and editable animation text.
- **Settings:** saved presets and category-based sharing/import, then display brightness/on/off,
  **Keep cap black unless an approach, scan or sound event is active**, LED text font, expandable test patterns and protocol log, and rotation/mirroring/transport settings.
  Loading a content preset opens its Hat section; loading a group preset opens Approach.

**Settings → Built-in presets** includes **Xebia 💜 GitHub**, **LGTM 👍** and literal
`<header>` scrolling text, the supplied **Xebia logo**, the **GitHub Copilot logo**,
and an animated **Party Popper** GIF. The artwork is bundled for offline use on web,
Android and iOS. Logos preserve their aspect ratio on black and the party animation
is supplied at the 32×16 display resolution. Load a built-in to preview or send it,
add it to a Custom sequence, or save an editable personal copy. Animated GIFs are
decoded locally: browsers with WebCodecs use the native decoder, while Bluefy on
iPhone uses the app's built-in JavaScript decoder. The same fallback applies to
uploaded GIFs.

Built-ins are not included in backups and cannot be removed by importing a backup.
Personal copies, current editor content loaded from a built-in, and sequences using
built-ins are embedded in **Creations** backups without remote image dependencies.

Choose **Settings → Display → LED text font** as the default for text on the LED matrix:
**Silkscreen** (compact, the default), **Tiny5** (large), **Press Start 2P** (arcade),
**DotGothic16** (tall), **Bitcount** (full height), or **Monaspace Neon** (full height). All six are bundled for offline use and rendered at their
native pixel sizes, except Tiny5 and Bitcount Prop Single, which use crisp 2x sizes for readability on the
16-row display. Bitcount's ascenders and descenders use all 16 rows. Monaspace Neon is a vector font from
GitHub Next, so it is scaled to the largest size at which every printable ASCII character fits the configured
display height. Glyphs have trimmed side bearings and a one-pixel gap between letters;
emoji get a two-pixel gap on each side so they never touch neighbouring letters.
Emoji retain their system colour appearance and reserve their actual
rendered width rather than an assumed square. The sample
and Hat preview update immediately (unless the text has its own font); send again to replace content already on the
hat. Running Approach content updates automatically; subsequent Scan greetings and
Sound reactions use the chosen font. The app remembers the choice after reload.
Font copyright and SIL Open Font License notices are bundled in [public/licenses](public/licenses/).

The UI retains its dark theme and blue accent, with larger touch targets, visible keyboard
focus, arrow/Home/End tab navigation, a non-colour selected-tab marker, responsive form
grids and wrapping long preset names. Diagnostics are expandable, not removed.
Existing stored content, settings, QR profiles, backup formats and BLE preset sharing are preserved.
See [the UI change record](docs/ui-improvements.md) for the expert review and implementation details.

## Native apps and approach mode

Besides the PWA, the project builds **Android** and **iOS** apps (Capacitor, `android/` and `ios/`) with the shared UI plus **Approach mode**: when caps come close, they show greetings for each other or one marquee spanning all caps, configurable for 1, 2, up to 4, up to 8, and more than 8 caps. While approach mode runs, presets can also be shared with a nearby phone; the receiver must accept the preset before it is transferred. See [docs/approaching-mode.md](docs/approaching-mode.md) for the detection design and [docs/INSTALL.md](docs/INSTALL.md) for building the APK.

Web Bluetooth requires a supported browser (for example Chrome on Android or desktop);
Safari on iOS does not support it. Editing, presets, QR profiles, manual QR entry and
backup/import work offline but require a connected cap, so they are not available in a
browser without Bluetooth. Camera scanning requires HTTPS
and permission. Imported native group presets are retained and can be exported again,
but cannot be loaded in the browser. Nearby BLE sharing is native-only; JSON file
sharing/download remains available on web. The `#mock` development mode deliberately
keeps all five tabs for simulated Approach scenarios.

## Web app regression tests

Tab navigation is wired before Scan and Sound restore their settings, so a slow
optional feature cannot leave all tabs unresponsive. Vitest tests the actual HTML
tab shell (selection, associated panels, hidden/native tabs, invalid targets and
keyboard focus). Playwright also reproduces stalled Scan/Sound initialization.

Run unit tests and the complete local browser suite against a production build:

```powershell
npm ci
npx playwright install chromium firefox webkit
npm test
npm run e2e
```

The existing hardware-mock/offline tests run in Chromium. Permission-free web
navigation smoke tests run in Chromium, Firefox and WebKit, with desktop/mobile
viewports, every visible tab, keyboard wrapping, reload and content retention
while switching tabs. They first check that only the connection controls are shown while
disconnected, then connect a simulated cap (`e2e/hat.ts` fakes Web Bluetooth and the native
BLE bridge); they do not request camera/microphone access.

To run the same smoke tests against the deployed app, including its subdirectory:

```powershell
$env:PLAYWRIGHT_BASE_URL = 'https://harrybin.de/iledcolor-app-native-added/'
npm run e2e:smoke
Remove-Item Env:\PLAYWRIGHT_BASE_URL
```

With `PLAYWRIGHT_BASE_URL` set, Playwright does not start a local server and runs
only the remote-safe navigation suite. Relative test URLs preserve the app's base
path rather than navigating to the host's root.

The **Web app tests** GitHub Actions workflow runs unit/local browser tests on
pull requests and main pushes. It checks the deployed URL daily, after a successful
Pages deployment workflow when `PAGES_ENABLED` is enabled, and through **Run
workflow**, where `base_url` can target another deployment. Failures retain HTML
reports, screenshots and browser traces for 14 days. Scheduled runs use the default
branch's workflow; these checks become active once the workflow is merged.

## Native unit tests

Pure Android/iOS plugin rules (update URL/checksum/version policy, approach beacon
content/read/write/name rules, motion math, sound language/PCM/downsampling and
proximity) live in framework-free helpers that the plugins call, so they run
without a device. Android uses JUnit in `android/app/src/test`; iOS uses XCTest in
the `ios/NativeRules` Swift package, whose `NativeRules.swift` is also compiled into
the App target. Android needs JDK 21, the Android SDK and a prior Capacitor sync:

```powershell
npm run build
npx cap sync android
cd android
.\gradlew.bat testDebugUnitTest
```

On macOS (or Linux with Swift 5.9+), run the iOS rules tests without Xcode:

```powershell
swift test --package-path ios/NativeRules
```

The **Native unit tests** workflow runs both on pull requests and main pushes. Real
Bluetooth, microphone, speech, installer and share-sheet behaviour still requires
physical devices; see [docs/test-coverage.md](docs/test-coverage.md).

## Sound and voice reactions

**Sound** is available on Android, iOS and web. Connect the primary cap and either send
content first or enable **Keep cap black when idle**, then tap **Start listening**. Applause and whistles trigger coloured
scrolling-text GIF animations on that cap only. Phrase categories cover greetings,
farewells, approval, food, thanks, questions, coffee breaks and celebrations.
Each category can be disabled and its animation text edited; **Preview animation**
works offline without a microphone or cap, and **Test on cap** exercises playback
and restoration without listening. Reactions use the existing temporary-content
controller, restore the previous content (or the black, display-off idle state when
**Keep cap black when idle** is enabled), skip busy/QR-greeting periods and apply
a 10-second cooldown. **End reaction** restores early. Firmware playback timing
and physical display behaviour still require real-cap verification.
New voice-reaction defaults include emoji, such as **HELLO! 👋**, **THANK YOU! 🙏**
and **COFFEE? ☕**. Cap texts accept printable ASCII and supported emoji (up to
40 characters); emoji appearance depends on the phone's system font. Existing
saved texts, including customized and older plain-text defaults, are kept unchanged.
Accepted wearer phrases vibrate once when their reaction starts, after voice
verification and the normal busy/pocket/cooldown checks. Rejected or duplicate
detections, room sounds, previews and manual reaction tests do not vibrate.

Phrases are off by default. First record a **12-second voice sample** in a quiet
place, then enable phrases and select **English** or **Deutsch** for the conversation.
The editable reaction list includes a built-in bilingual dictionary, including
“hello / guten Morgen”, “nice to meet you / schön dich kennenzulernen”,
“bye / tschüss”, “awesome / toll”, “food / Frühstück” and conference phrases.
Phrases also match within sentences, for example “Well, nice to meet you, everyone!”.
Matching normalizes case, accents, punctuation and whitespace, uses whole-word
boundaries (not substrings such as “hi” in “shipment”), and prefers longer phrases.
The recognizer listens in one selected language at a time; it does not switch
languages automatically.

The local **experimental wearer filter** compares pitch and acoustic cepstral
features throughout the recognized utterance with the saved sample. Missing audio,
insufficient clear speech or a mismatch rejects the phrase; a match from an earlier,
unrelated utterance is not enough. This is **not a trained speaker-embedding model,
biometric authentication or a guarantee of wearer-only activation**. Similar voices,
replays, microphone position and conference noise can cause false acceptance or
rejection. Applause and whistle recognition is likewise a conservative acoustic
heuristic, not a trained sound-event classifier; music, beeps and other noise may
trigger it. Other people's applause intentionally does not need a wearer match.

| Platform | Audio and speech | Pocket detection |
| --- | --- | --- |
| Android | App-local `SoundDetection` plugin captures mono PCM. Phrase recognition requires Android 13+, a compatible on-device speech service, and an installed model for the chosen language; older/unsupported devices can use room sounds and voice sampling. No minimum-SDK increase. | Optional hardware proximity sensor; unavailable sensors are reported. |
| iOS | App-local `SoundDetection` plugin uses AVAudioEngine and on-device-only Speech recognition. Microphone and, for phrases, speech permissions are required. Unsupported/unavailable language models reject speech startup rather than using server recognition. | UIDevice proximity monitoring on supported devices; commonly unavailable on iPads. |
| Web/PWA | HTTPS/localhost, Web Audio/AudioWorklet and microphone permission are required. Speech also requires browser SpeechRecognition support and explicit **Allow browser speech recognition** consent: the browser provider may process audio remotely and require internet. Sound detection and voice sampling are local. | Not available: browsers do not expose a reliable proximity sensor here. Automatic pocket pause is disabled, not simulated. |

**Pause recognition while the phone is in a pocket** is on by default where a
sensor exists. A covered sensor lasting at least 500 ms pauses sound analysis
and phrase reactions; uncovering clears stale audio and resumes them. Microphone
capture remains active while paused. With the option off, a covered-sensor warning
explains that muffling may reduce accuracy. Proximity is only an indication:
a hand or nearby object can cover it too.

Listening stops when leaving Sound, hiding/locking the app, losing microphone
access, or tapping Stop. There is no background recording service or background
entitlement. Keep the app foregrounded through cap playback/restoration.
The app persists only sound settings and a local acoustic voice template, not raw
audio or transcripts. **Delete voice sample** removes the template; audio buffers
are cleared when stopped. Sound settings can be included in backups (Settings →
Backup → **Sound settings**); the voice template and the browser speech permission
are never exported. Browser speech-provider privacy policies apply if that service is enabled.
Native plugins are registered directly in MainActivity/AppViewController, so they
do not appear as npm plugins in `cap ls`; rebuild the native app after synchronizing.
Native permissions, language-service support, proximity screen-off behaviour and
speaker/noise accuracy must still be verified on physical phones.
Vibration uses the Capacitor 8 Haptics plugin on Android/iOS and the Vibration API
where supported on web; unsupported hardware/browsers or denied feedback do not
interrupt recognition or scanning. Rebuild native apps after sync to include Haptics.
Actual vibration strength and delivery require physical-device verification.

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
**Creations** (saved text, colors, images, GIFs, GitHub configurations and sequences,
all current Hat section drafts including text font and image fit/background before
choosing a file, current content and sequence steps including a paused sequence draft,
plus the current GitHub handle, prefix/postfix text and independent scroll speed),
**Approach settings** (saved group presets, current group content, mode, beacon and nearby-cap detection),
**Scan settings** (proximity thresholds, timing, QR profiles, current greeting/regex,
repetitions, speed and scan-logging preference), **Display & transport settings**
(LED text font, keep-cap-black-when-idle preference, dimensions, brightness, rotation,
mirroring and Bluetooth write settings; older backups without a font or keep-black
preference keep your current choice), and
**Sound settings** (room sounds, phrases, language, pocket pause, enabled reactions and
their cap texts, including emoji and custom texts). No new vibration setting is required.
Importing Sound settings stops active listening; the voice sample and
the browser speech permission stay on each device, so record a voice sample on the
receiving phone before using phrases.
The system share sheet sends a JSON file. Import replaces only the included categories,
keeping excluded presets and settings unchanged. Importing Scan settings can enable
local scan logging; log contents and scanned QR payloads are never included. Phone
identity, cap connections, permissions and live running state are not shared.
Older version-2 files keep newer settings they do not contain. Older full JSON backups
remain importable with their original full-replacement behavior. Reconnect after importing
transport settings to apply the new write profile.

## GitHub contribution graph

Expand **Custom → GitHub Contributions**, enter a public GitHub handle (without `@`), choose
**Load graph**, then **Send to cap** once connected. The preview and hat scroll the
past year (53 calendar weeks, including the current partial week) from right to left
as a looping marquee at this section's scroll speed: oldest week first, Sunday at the
top, with five green-only intensity levels (no red or blue,
which the hat's LEDs would otherwise shift toward blue). Each day
uses 2 x 2 LEDs, centered vertically, giving a 106-LED-wide strip that the hat plays
itself as a GIF animation. Future days and missing data
remain black. **Prefix text** and **Postfix text** configure what scrolls before and
after the graph. Their defaults are `2026 contributions by {handle}: ` and two
full-colour party-popper emojis (`🎉🎉`). Use `{handle}` in either field to insert
the loaded user's handle. Both fields accept up to 200 characters of printable ASCII
and emoji; leave a field empty to omit that caption. Spaces are preserved. Editing
captions immediately updates a loaded preview without fetching contributions again;
choose **Send to cap** to upload the updated animation. Very long captions can exceed
the hat's upload-size limit; shorten them if an upload reports that limit.
**Font** picks the caption font, or **Use Settings default** to follow the LED text
font in Settings. Emoji appearance follows the device's system emoji font. Caption colors are reduced
to a GIF-safe palette before preview and upload so all five graph intensities remain exact.
Loading or uploading a graph
does not change the content editor.

Loading requires internet and sends the entered public handle to the third-party
[GitHub Contributions API](https://github.com/grubersjoe/github-contributions-api).
No token is needed; results may be cached for an hour. Errors are shown without
uploading a placeholder graph. Reload the graph to refresh it; there is no background
polling. **Save as preset** stores the handle, captions, caption font and speed, plus the loaded
graph and its date when a graph is loaded for that handle. Such presets replay the
stored graph offline (in the editor, sequences and Approach mode) until you load the
graph again; presets saved without a graph fetch a fresh one each time they are shown.
Sharing GitHub presets requires a receiving
app version that supports them. The handle, both caption fields, caption font and speed are saved locally and included in **Creations** backups;
the editor's fetched data and live display state are not. Import updates the field immediately
without fetching or uploading; older backups that omit these fields preserve their
local values, including handle-only backups from earlier versions.

## Badge scanning and greetings

The **Scan** tab reads QR codes and 1D barcodes with the camera, or captures printed
badge text for on-device English OCR. Scanning works in the Android/iOS apps and in an
HTTPS browser with camera permission. Scanner assets, including the OCR engine and
English model, are bundled and cached for offline use (about 7 MB). Scan data is not
sent to a server. Only the primary cap connected to the scanning phone is interrupted;
other connected caps continue unchanged. The camera stops after a code scan or OCR
capture, on Stop, on changing tabs, or when the app is hidden.

For OCR, center the printed name and company in the preview and tap **Capture text**.
The parser recognizes plain text, JSON, vCard, MECARD, and multiline badge text,
including company, job title, email, phone, URL, and notes. Configure a greeting such as
`Hi {name}!`, its scroll speed, and repetition count (**3 by default**). Save up to
**three scan profiles** locally, each with a regex, greeting template, and note; **None**
selects the general parser. Regex named groups can include `name`, `firstname`,
`lastname`, `company`, `title`, `email`, `phone`, `url`, and `notes`; greeting templates
can use each of these fields. Manual scan-data entry is available when a camera cannot
be used. Invalid or unmatched patterns show an error without changing the cap.

Scanning works without a cap and shows results without sending a greeting. To play greetings, send content to the cap first or enable **Keep cap black when idle**:
the protocol cannot read back content installed by another app or before the current
connection. The app retains the last successfully sent image or GIF, including content
sent by Approach mode; when keep-black is enabled, the cap restores its black,
display-off state after the greeting. The greeting scrolls using a finite-loop GIF and
the requested repetition count. Approach updates for the primary cap wait during the
greeting; other caps are not paused. **End greeting** restores content early. Keep the
app open through playback and restoration because phones can suspend JavaScript in the
background.

Scanner configuration stays in local storage. Scanned data is not persisted unless
**Save all scanned data to a local file** is enabled (off by default). While enabled,
camera scans, OCR captures, and submitted manual entries are logged before extraction,
including scans whose greeting fails. The local `qr-scan-log.jsonl` file contains one
JSON object per line with a UTC timestamp, source (`camera`/`ocr`/`manual`), the complete
unmodified payload, and selected profile ID/note (or `null`). Logs may contain personal
data; obtain appropriate consent and share only with trusted recipients. The app does
not upload scans; logs are excluded from preset backups. **Share scan log** opens the
native share sheet or shares/downloads the file in supported browsers.

Credits: inspired by **Rob Bos / Xebia's [badge-scanner](https://github.com/xebia/badge-scanner)**.
No code was copied from that repository, which had no declared license when inspected.
The scanner bundles ZXing Browser (MIT), ZXing JS (Apache-2.0), and Tesseract.js
(Apache-2.0) with its English model. Credits and licenses are shipped in
`public/licenses/` and linked in the Scan tab. Assets are bundled locally and cached
for offline use; no native scanner plugin or Android minimum-SDK increase is required.

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

### In-app update check

The Android and iOS apps check [GitHub Releases](https://github.com/harrybin/iledcolor-app-native-added/releases)
a few seconds after startup (at most every 6 hours, anonymously via the GitHub API) and show an
**Update** banner when a newer published, non-prerelease version contains an asset for the
platform. **Settings > App updates** shows the installed version and offers a manual check.
Installation never starts during a cap upload or temporary display.

- **Android** downloads `led-hat-vX.Y.Z-android.apk`, verifies it against
  `SHA256SUMS-android.txt`, checks that it is a newer build of `com.harrybin.ledhat`, then opens
  the system installer. Android always asks for confirmation; on first use it opens the
  *Install unknown apps* setting for LED Hat. Updates install only when signed with the same key.
- **iOS** opens the over-the-air installer (`itms-services`) using `led-hat-vX.Y.Z-ios.plist`,
  which the iOS release workflow publishes next to the IPA. Only devices registered in the Ad Hoc
  profile can install it; older releases without the manifest are not offered.
- The browser PWA keeps updating through its service worker and does not query GitHub.

No setting is stored for this feature, so backups are unaffected.

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

#### One-click new version (GitHub Actions)

After these workflow changes are on the default branch, open **Actions > Release new app
version > Run workflow**. Select the branch containing the app you want to release, choose
**patch** (default), **minor**, or **major**, and select **android** (default) or
**android-and-ios**. This is a real publishing operation, not a preview.

The [workflow](.github/workflows/release.yml) runs the same `npm run release:patch/minor/major`
scripts used locally, checks the synchronized metadata and release tests, commits the four
version files to the selected branch, and atomically pushes that commit and its `vX.Y.Z` tag.
It then calls the existing Android/iOS workflows directly: each runs tests, builds the web
assets, performs Capacitor sync, signs its native package, and publishes its downloads and
checksums to the same GitHub Release. iOS also publishes its OTA `.plist`. Android can publish
even if the optional iOS build fails. This does not deploy Pages, produce an AAB, or submit
to Google Play, TestFlight, or the App Store.

**Required setup:** enable Actions, allow `GITHUB_TOKEN` **contents: write**, and configure
the signing secrets listed above. Android secrets are always required; selecting iOS also
requires all three iOS secrets. Missing secrets fail before any version commit/tag is pushed.
The selected branch and `v*` tag rules must permit the Actions bot's direct updates; this
workflow does not bypass protected branches or approval rules. No PAT is needed. Only run
from trusted branches: their code executes with release credentials. A configured but invalid
certificate/key can still fail later during signing.

Concurrent new-version runs are serialized. If the selected branch has moved since dispatch,
the atomic push fails rather than overwriting work; start a fresh run from the updated branch.
Once preparation succeeds, a build/signing failure leaves the version commit and tag in place.
Fix the setup and use **Re-run failed jobs** (or the individual platform workflow with that tag)
to finish the same release. Re-running all jobs in the same run reuses its tag; a **new**
dispatch increments the version again. No force pushes or tag replacement are performed.
Tags pushed with `GITHUB_TOKEN` do not trigger the tag-push workflow, so the reusable workflow
calls are intentional and do not depend on an extra token or duplicate Android runs.
Only the new orchestration workflow makes version commits; the standalone platform workflows
retain their existing manual/tag behavior.

#### Local preparation and standalone platform builds

`package.json` is the version source, with `package-lock.json` kept in sync.
The npm `version` hook updates Android's `versionName` and iOS's `MARKETING_VERSION`, plus both
native build numbers. Only stable `MAJOR.MINOR.PATCH` versions are supported (no prerelease/build
suffixes). The build number is `MAJOR * 1000000 + MINOR * 1000 + PATCH + 1`: `0.2.0` becomes
`2001`. Minor and patch are limited to 999 and the build number to 2100000000. Always increase
the version; reusing a tag/build number is not a new release.

To prepare a new version locally, run one of these commands:

```powershell
npm run release:patch
npm run release:minor
npm run release:major
```

Each command increments the selected version component, synchronizes the npm manifests and
Android/iOS version metadata, and checks they agree. It does not stage, commit, tag, push, build,
or publish anything. In VS Code, use **Terminal > Run Task > Release: Prepare new version locally**
and choose **patch**, **minor**, or **major**. Run it once per intended version bump.

For example, prepare the next patch from the repository root on Windows:

```powershell
npm run release:patch
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

You can also start **Actions > Build Android release / Build iOS release > Run workflow**,
for example after correcting signing secrets. Android asks for no version: it reads `package.json`
from the selected branch's commit and checks that the npm manifests and native metadata agree.
If the corresponding tag (for example `v0.2.0`) exists, Android builds that tag. Otherwise it builds
the selected commit and creates the tag at that exact commit when publishing the successful build.
No version bump is performed; prepare and commit version changes before running the workflow.
iOS requires an existing full `v0.2.0` tag and never creates tags.

Pushing a tag starts the Android build automatically; manual Android runs also support releasing
a prepared commit without first pushing a tag.
Use **Re-run failed jobs**
for transient failures. Retrying a workflow replaces only its own platform's package and checksum
file, leaving the other platform's downloads intact. New app versions must still use a new version
and tag. A newly created draft is published after that platform's upload succeeds; the other
platform does not need to finish first.
Build artifacts remain available in Actions for seven days; the GitHub Release assets are the
persistent downloads. Neither workflow generates version-bump commits.

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
