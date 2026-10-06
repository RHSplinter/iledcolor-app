# Local Android LED Hat Controller

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
