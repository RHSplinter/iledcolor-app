# Cross-platform test coverage

The web/shared tests execute the real TypeScript adapters with mocked external
APIs, not source-text assertions. “Android/iOS shared” means TypeScript used by
both Capacitor shells. Native Java/Swift plugin rules have their own JVM JUnit and
XCTest suites (see [Native plugin coverage](#native-plugin-coverage)).

## Added TypeScript coverage

| Suite | Platform scope | Regressions covered |
| --- | --- | --- |
| `tests/web-bluetooth.test.ts` (16 tests) | Web | Secure-context/API support detection; default/custom chooser filters and A950 access; unnamed devices; chooser cancellation versus permission/ordinary errors; absent GATT and connection failure; service/characteristic/notification startup failure cleanup; A951/A952 write-without-response and A953 notify validation; notification startup ordering; command/data routing and write failures; copied DataView notification subranges; unsubscribe; unexpected versus intentional disconnects. |
| `tests/native-ble.test.ts` (25 tests) | Android/iOS shared | Concurrent/cached initialization and retry after rejection; permission failures; chooser options, name fallback and cancellation versus errors; uppercase UUID normalization; missing service/characteristics/properties; connection/discovery/notification startup failures and cleanup even if disconnect rejects; notification startup ordering; per-device A951/A952 write routing preserving byte offsets/lengths; write errors; copied notification subranges; per-device subscriptions/unsubscribe and disconnect listeners; intentional disconnect suppression; duplicate low-latency scan options, callback forwarding, scan errors and tolerated stop failures. |
| `tests/share-file.test.ts` (7 tests) | Web and Android/iOS shared | Native Cache/UTF8 writes complete before URI sharing; native cancellation versus share/filesystem errors; web filename/MIME/Unicode content; Web Share AbortError versus other errors without download fallback; download fallback for absent/false `canShare`, attached link click/removal and exact object URL revocation timing. |
| `tests/app-update-install.test.ts` (10 tests) | Android shared branch / iOS shared branch | AppUpdater registration; Android checksum precondition; listener registration completes before download; exact download arguments and progress forwarding; installing/permission-required results; listener removal on success/failure, registration rejection, no-progress path and awaited cleanup; encoded iOS itms-services URL and installer rejection without Android download/listener calls. |

BLE initialization and update plugin registration are re-imported with isolated
module state between tests. Browser tests use jsdom and restore globals/mocks;
download cleanup uses isolated fake timers. Pending-operation tests explicitly
control promise completion to verify ordering, rather than relying on sleeps.

Existing controller/framing/motion tests remain the protocol/lifecycle layer.
Existing Playwright tests cover production-built UI, offline/mock-cap workflows,
platform-specific layout/update prompts, and permission-free navigation in
Chromium, Firefox and WebKit. Their simulated Capacitor globals do not constitute
native runtime coverage.

## Native plugin coverage

Before this change Android had only placeholder example tests and iOS had no test
harness. Decision logic was moved, without behaviour changes, out of the plugins
into framework-free helpers that the plugins now call:

| Helper | Used by | Tests |
| --- | --- | --- |
| `android/.../UpdatePolicy.java` | `AppUpdaterPlugin` | `UpdatePolicyTest` (10): accepted repository release URLs; missing arguments, foreign hosts/repositories, insecure URLs and unexpected file names rejected; checksum parsing (case, `*` binary marker, whitespace, missing/malformed entries); SHA-256 digest including multi-buffer inputs; strictly newer numeric Android version codes. URL traversal/query handling, release-tag and URL/file-name matching, duplicate checksum entries and semantic version ordering are not asserted. |
| `android/.../BeaconRules.java` | `ApproachBeaconPlugin` | `BeaconRulesTest` (11): content UUID slots, 8-byte header and 512-byte limits, read offsets/MTU-bounded slices, share inbox write acceptance (prepared/offset/oversized), `LH` name payload trimming and 20-byte UTF-8 truncation, motion magnitude, 100 ms sample throttle and 250 ms rotation freshness. |
| `android/.../SoundRules.java` | `SoundDetectionPlugin` | `SoundRulesTest` (6): supported/installed languages, little-endian PCM16 encoding, sample normalization, proximity “near” threshold. |
| `ios/NativeRules/.../NativeRules.swift` | iOS `ApproachBeaconPlugin`, `AppUpdaterPlugin`, `SoundDetectionPlugin` | 22 XCTests: `BeaconRulesTests` (9) content UUIDs/decoding/status/share writes/read slices/name/motion; `UpdateRulesTests` (4) itms-services manifest trust; `SoundRulesTests` (9) languages, 16 kHz cap, mono clamping and the fractional box downsampler (integer and 44.1 kHz ratios, frame size/remainder, reset, clamping). |

`NativeRules.swift` lives in a Foundation-only Swift package and is referenced by
the Xcode App target, so the app and the tests compile the same source. The stale
Android instrumented smoke test now expects the real `com.harrybin.ledhat` package.
The **Native unit tests** workflow runs Gradle `testDebugUnitTest` on Ubuntu and
`swift test --package-path ios/NativeRules` on macOS.

## Validation on Windows, 2026-10-19

| Command | Actual outcome |
| --- | --- |
| `npm test -- tests/web-bluetooth.test.ts tests/native-ble.test.ts tests/share-file.test.ts tests/app-update-install.test.ts` | **58 passed**, 4 files. |
| `npm test` | **335 passed**, 20 files, including the 58 additions. |
| `npm run typecheck` | Passed. |
| `npm run test:release` | **7 passed, 2 failed** in unchanged release tests; see below. |
| `npm run test:icons` | **2 passed, 1 failed** in the unchanged reproducibility test; see below. |
| `Remove-Item Env:\PLAYWRIGHT_BASE_URL -ErrorAction SilentlyContinue; npm run e2e` | **46 passed**, including the local production build and all three configured browser projects. No remote-only smoke restriction. |

The first focused attempt failed because `vitest` was missing. Only then was
`npm ci` run (557 packages installed; npm reported 3 moderate audit findings).
No dependencies or lockfile were changed. Browser prerequisites were already
available; no browser installation was needed.

### Existing Windows gate failures

- Release tests `Android publishing creates and verifies the tag at the
  validated build commit` and `Android manual releases derive the tag from
  validated project files` assume LF in literal workflow splits/includes.
  `git ls-files --eol .github/workflows/release-android.yml` reports index LF,
  working-tree CRLF. They fail before exercising publication behavior.
- Icon test `native icons are reproducible; PWA identity is unchanged` compares
  bytes before/after generation. The checked-out `assets/native-icon.svg` is
  CRLF (837 bytes); the generator writes LF (824 bytes). The SVG was restored
  after the check; no generated native assets are included in this change.

These are pre-existing checkout-sensitive test failures, not failures in the
new adapter regressions. No runtime production defect was exposed by the new
tests. The existing gates have **not** been reported as passing.

## Subsequent native unit validation, 2026-10-19

These checks followed the Windows web validation above:

| Command | Actual outcome |
| --- | --- |
| Gradle `testDebugUnitTest compileDebugJavaWithJavac` after web build and Capacitor Android sync | **28 passed** (27 new JUnit tests and the existing example); Android plugins compiled using JDK 21 and the Android SDK on Windows. |
| `swift test` for `ios/NativeRules` | **22 passed** using Swift 6.1.2 on Linux through WSL; this compiles the standalone rules and tests, not the iOS App target. |
| Native unit tests workflow | Android unit tests passed on Ubuntu and the standalone Swift package tests passed on macOS. Neither job runs device integration tests or builds the iOS App target. |

## Remaining native/device limitations

- The iOS App target, its refactored plugins and the Xcode project reference to
  `NativeRules.swift` remain build-unverified. Passing standalone XCTest tests
  does not establish that UIKit, CoreBluetooth or Capacitor integration builds.
- Android instrumentation, emulator, simulator and physical-device tests were
  not executed. The instrumented smoke assertion now expects
  `com.harrybin.ledhat`, but that correction has not been exercised on a device.
- OS integration remains untested here: real BLE
  permissions, radio/GATT behavior, multiple physical caps, notification timing,
  backgrounding and reconnection; native filesystem/share sheets and permissions;
  Android APK download/checksum/package validation and installer permissions;
  iOS manifest acceptance, signing/provisioning and installer handoff.
  The update adapter tests prove argument/ordering/cleanup contracts, not that
  the native downloader verifies bytes or that an app installs successfully.
