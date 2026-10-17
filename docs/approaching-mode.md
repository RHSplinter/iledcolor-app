# Approach mode (native apps only)

Approach mode notices when LED caps come close together and changes what the caps show:

- **Individual**: every cap shows its own text, for example a greeting to the other caps (`Hi {other}!`).
- **Span**: one marquee runs across all caps in the group, left to right, so the text flows from cap to cap.

The content is configured per group size. The tiers are: **1 cap (alone)**, **2 caps**, **3–4 caps**, **5–8 caps**, and **more than 8 caps**. Each tier has its own mode, text template, colors, and speed. The templates support:

- `{me}`: this cap.
- `{other}`: the other caps, for example "Fox", "Fox & Owl", or "5 friends".
- `{count}`: the group size.
- `{index}`: this cap's position in the group.

Approach mode is only available in the Android and iOS apps (Capacitor). The web app cannot scan advertisements or advertise.

## Why detection needs the phones

A cap accepts **one** BLE connection. We confirmed on the hardware that a cap **stops advertising while it is connected**. When two caps meet, they cannot see each other, and a connected cap is invisible to other phones. Detection therefore uses the phones. The app combines three sources:

| Source | How it works | When it helps |
|---|---|---|
| **Hub**: caps connected to this phone | The phone reads each connected cap's RSSI once per second. Caps near the phone are near each other. | One phone drives several caps, for example a group of kids with one parent's phone. Android typically handles about 7 simultaneous connections. Use several phones for more caps. |
| **Peer beacons**: other phones running the app | Each phone advertises a non-connectable BLE beacon and scans for others. The beacon is a 128-bit service UUID containing the magic `LEDH`, a version (2), the number of caps the phone controls, a random phone ID, 16-bit hashes of up to two cap names, and a 16-bit *near mask* (Bloom filter of the phones it currently sees near). Version 1 beacons (`LEDHAT`) are still understood. | One phone per wearer. The beacon carries the cap count, so a phone with 3 caps adds 3 to the group. This scales to large crowds (>10): each phone only listens and computes, and no connections are needed. |
| **Nearby caps**: caps advertising, not connected here | Scan results whose name starts with `iledcolor` | Caps that nobody has connected yet. Caps already counted through a peer beacon (name hash) are not counted twice. |

The service-UUID encoding exists because iOS can advertise only service UUIDs and a local name, not manufacturer data. The same beacon therefore works on both platforms.

### Hub mode vs. P2P mode

Both use the same Approach tab and engine; only the setup differs.

- **Hub ("master")**: one phone connects several caps; their proximity is the RSSI between that phone and each cap.
- **P2P**: every wearer runs the app on their own phone with their own cap connected and starts Approach mode.
  Phones detect each other through the `LEDH` beacon; each phone only uploads to its own cap.
  While another phone is near (≥ enter threshold, settled), the cap shows the group tier (greeting or its marquee slice);
  when it drops below the leave threshold or is not heard for `staleMs`, the cap falls back to the solo content.
  Hub and P2P mix freely: a phone with 3 caps meeting a phone with 1 cap forms a group of 4.

For a P2P spanned marquee all phones must use the same tier text/colours/speed, because each phone renders its
own slice locally. **Texts of nearby caps** shows each near cap's original text template, mode, colours and
speed for the current group size. **Use text** saves that cap's full text settings for this group size on
this phone. With two caps, select a matching text manually.

With **three or more caps**, marquee mode automatically uses the marquee text that has a **majority**:
more than half of all caps in the group propose it (for example 2 of 3, or 3 of 5; 2 of 5 is not enough).
Without a majority, every phone keeps its own text and texts can be adopted manually.
Each cap has one vote, including multiple caps controlled by a Master phone. Templates are compared exactly,
before replacing `{me}`, `{other}`, etc. If several caps propose that text with different colours or speeds,
the first cap in the shared phone-ID/cap order supplies those settings. The winning entries are marked
**Majority · used automatically**. Ties keep this phone's own text and allow manual adoption.
Individual greetings are not overridden or counted as marquee votes.

The automatic choice is temporary: the original saved proposals keep their votes and are shared unchanged,
so a temporary choice cannot turn itself into a manufactured majority. Leaving the group or changing tier
re-evaluates the choice. Automatic selection waits for fresh content from every group member; missing text,
an older app, or a failed transfer is shown explicitly and never treated as agreement.

Texts are exchanged directly over Bluetooth, without a server or a connection to another person's cap.
While approach mode and its beacon are on, the phone publishes a **read-only GATT service** containing the
five group-size text configurations (not Connect tab text, images or animations). Nearby app users can read
these settings without pairing; do not use private text in these templates. Phones read the relevant tier
over short-lived phone-to-phone connections while keeping their cap connections. A header checks the
phone ID and content revision before and after each read; length-prefixed UTF-8 rejects incomplete reads.
Successful reads are refreshed every 5 s when the Bluetooth queue permits, oldest reads first. Cached text
expires after 15 s (or 5 s per nearby phone in larger groups, allowing a full read round), and failures retry
after 30 s. Turning approach mode off removes the service and clears received texts.
Both phones need the updated native app for text sharing. Existing beacons remain version-2 compatible;
an older app can still participate in proximity detection, but its texts are unavailable.

Slice order follows phone IDs (not physical left/right); start times are aligned to the phones' clocks (see Span mode).

Hardware check (Pixel 9 Pro, release APK, one cap per phone): with only cap A connected, the phone grouped the
still-unconnected cap B (2 caps → greeting uploaded to cap A). Connecting cap B elsewhere (it stops advertising, as when
another phone takes it) returned cap A to the solo content after ~9 s; releasing cap B brought the greeting back after
~7 s. The phone-to-phone beacon path is covered by unit and mock tests; it still needs a run with two app phones.

### Proximity and grouping

- **Filtering**: each raw RSSI report first passes a median of the last three reports (at most 2.5 s old), which removes single outliers such as one reflected or body-shadowed packet. The result is smoothed with an exponential moving average weighted by the time since the previous report (30 % per second), so a phone that delivers ten advertisements per second does not react faster than one that delivers one; a report after a long pause counts as at most 3 s.
- **Confirmation**: a participant only becomes near, or away, after at least two reports on the new side that span the **Confirm** time (1 s by default, 0–10 s, Detection section; halved while the phone is moving). A short weak burst that recovers resets the pending change.
- The app uses hysteresis with defaults: **near ≥ -70 dBm** (≈ 2 m) and **away < -75 dBm** (≈ 4 m), so a cap is put back to its alone content before it is really out of Bluetooth range — useful in Master mode, where a cap walking away stays connected for a long time. These thresholds can be set in the app; the **Away beyond 3 m / 4 m / 5 m** buttons set the away threshold from a distance. Saved settings with the old -80 dBm default are moved to -75 dBm. Entries without updates expire after 8 s (see the radio-gap rule below for near ones).
- **Symmetric proximity**: two phones rarely receive each other equally well (antennas, pockets, a throttled scan). A peer therefore also counts as near when the peer's near mask lists this phone and this phone hears the peer plausibly: within the last 4 s and no more than 10 dB below the away threshold (at most -85 dBm with the defaults). The mask only uses each phone's own reception, so the rule cannot latch; both phones enter and leave the group together. The plausibility checks stop stale beacons and accidental matches of the 16-bit near mask (two bits per phone) from pulling in a phone that is far away. The "Nearby phones" list shows such peers as "near (sees you)".
- **Chains for marquees**: when A–B–C stand in a row, A and C may be too far apart for each other, while B sees both. If the group with the extra phones would run a **marquee across all caps**, a phone also includes peers it hears that are near a group member, as long as both phones' beacons (heard within 4 s) list each other. All phones of the chain then compute the same group, cap count and slice order, so the marquee runs consistently across all caps. Greetings (Individual mode) stay with direct neighbours. Such caps show "(via group)" in the status.
- **Keep-alive**: the beacon is re-advertised every 10 s and whenever its content changes, because some phones stop advertisers silently. The scan is restarted every 4 minutes, since some phones (for example Xiaomi, with a 5-minute `scan_timeout`) quietly downgrade long-running scans, and also after 15 s without any received advertisement. Silence is interpreted: a participant that was near with a steady signal is kept for twice `staleMs` (16 s by default) after it was last heard, so short radio gaps (scan restarts, missed advertisements) do not split a group. If the whole scanner hears nothing at all for 2 s or more, near participants are held up to 10 s longer, since the problem is then this phone's receiver. A participant whose smoothed signal was already below "Near at" and falling (at least 0.5 dB/s) when it went silent is treated as walking away and expires after `staleMs`.
- A changed group must stay stable for the **settle time** (2 s by default) before caps are updated. This stops flicker at the edge of the range.
- **Phone motion support**: while approach mode runs, native Android/iOS sensors provide gravity-free acceleration and gyroscope rotation magnitudes. Motion never decides whether a cap is approaching or leaving by itself: RSSI still supplies the distance evidence, with the same enter/leave thresholds, settle time and expiry. While the phone is moving, at least three threshold-crossing reports spanning 1 s make the RSSI filter respond faster. Reports less than 250 ms apart do not add confirmation, and gaps over 1.5 s reset confirmation. During turning, the filter dampens brief RSSI swings caused by antenna/body orientation; sustained crossing evidence over 2 s restores normal filtering so continued rotation cannot freeze a group. Still phones use the original filter, including when the *other* wearer moves.
- Sensors are active only for approach mode, pause in the background and resume in the foreground. Missing sensors, denied access, runtime failures, or samples older than 1.5 s fall back to the original RSSI filter. The status shows the motion state or fallback reason. Android uses the linear-acceleration sensor and, when present, the gyroscope; iOS uses Core Motion device motion. These are exposed through the existing app-local native plugin rather than browser motion events, so resuming a saved approach session does not depend on a browser permission gesture. No new Android permission or location access is needed for motion. Acceleration/rotation samples remain on the phone and are not saved or advertised.
- Every phone sorts the group the same way (by phone ID, then cap index), so all phones agree on the left-to-right order of a spanning marquee and on who is "first".
- **Mode** (Approach tab, changeable while approach mode is off): **P2P** (default) uses one cap per phone and always advertises the phone; the multi-cap controls (Add cap, saved caps, order, beacon and nearby-cap checkboxes) are hidden. **Master** lets one phone control several caps and shows those controls. Switching to P2P disconnects all caps except cap 1 (the saved list is kept).
- The cap connected on the **Connect tab** is cap 1 of the Approach tab (one shared connection): connecting there adds it in front (or moves it to the front), "Disconnect" there disconnects cap 1 and stops its automatic reconnect, and the content editor below the connection controls sends to it.
- The **Approach mode switch** (Approach tab, below your name) turns scanning, the phone beacon and the automatic uploads on and off. Switching off also restores the configured **1 cap (alone)** content on every connected local cap, after any in-flight group upload finishes; it does not leave a greeting or a span segment on the cap. Keep the caps connected until this reset finishes. The phone remembers the switch: if it was on when the app closed, the next app start reconnects the saved caps and resumes approach mode on its own.
- **Your name** (Approach tab, top) is the human-readable name of this phone's wearer. It is saved on the phone and used as the label of your caps ("Anna", "Anna2", …) unless you rename a cap. It is also sent to other phones next to the beacon UUID: Android puts it in the scan response as manufacturer data (company ID `0xFFFF`, prefix `LH`, at most 20 UTF-8 bytes, so ~10 umlauts or 20 ASCII letters), and iOS sends it as the advertised local name. Other phones show it in the group pills and the "Nearby phones" list and greet with it ("Hi Anna!"). Without a name, a phone falls back to a deterministic animal name derived from its phone ID ("Fox", "Owl2", …), which every phone computes the same way. If your first cap has its own label, that label is sent instead, so all phones use the same text for span marquees.
- Local caps that are not near get the "1 cap" content.
- Under **1 cap (alone)**, enable **Use Connect tab content** to use the current text, solid color, image or GIF from Connect instead of the solo Approach template. This content returns when the caps separate or approach mode is switched off. The content and the choice are remembered across restarts. Group presets include the choice; the referenced content stays local to each phone and can be transferred separately as a normal content preset.
- **Group content presets:** "Save as preset" below "Content per group size" stores the content of all five group sizes under a name. It appears on the Settings tab as "group content". **Load** applies it in the Approach tab; if approach mode is on, the new content is sent to the caps. Group presets are included in category-based share/import (field `groups` instead of `content`). Import validates all group sizes strictly and rejects the whole file on any error; legacy version-1 backups remain supported.

### Span mode

All spanning **Marquee** options are marked **unstable** in the UI. The feature remains
available, but physical ordering and synchronization may not match the intended display;
use Individual greetings when reliability matters.

The text is rendered once as a wide strip. Each cap gets its slice as a looping animation with the same frame count and timing, at most 120 frames to stay within the cap's 64 KB transfer limit. Uploads to caps on the same phone run in parallel. Playback of a cap starts when its upload ends, and uploads finish at different times (different phones, settle moments and GIF sizes). Unaligned slices look like a separate marquee on every cap, so the app sends the final EndStream only on a shared wall-clock boundary (a multiple of the loop period, with whole-centisecond frame delays). All caps of the group, on this and other phones, therefore start the loop together; across phones the accuracy follows the phones' clock sync (usually well under a second). This adds up to one loop period of waiting before a new marquee starts.

The cap can play an animation too fast after its content changes, for example when a group separates and later re-forms with the same greeting. To avoid this, every animation upload first sends its first frame as a still image to stop the running animation. Every GIF also gets a random nonce in unused palette entries, so the cap never receives byte-identical content twice. The nonce does not change any pixel.

**Physical direction cannot be inferred from these sensors.** Accelerometers and gyroscopes measure the
phone's own motion, not the bearing or position of another phone/cap. Integrating their readings into
positions drifts quickly, and phones may sit in differently oriented pockets rather than on the caps.
Motion support therefore does not reorder marquee slices. In Master mode, use the cap list's left/right
buttons to set local cap order; across phones the deterministic phone-ID order remains. Reliable automatic
physical ordering would need relative-position measurements, such as direction-capable UWB on supported
hardware, or an explicit shared layout/calibration.

### Troubleshooting P2P

Tested with two real phones (Pixel 9 Pro and Xiaomi with MIUI / Android 12), one cap each. Both formed a group of 2 within seconds and greeted each other by user name. Walking away returned each cap to its solo content after ~12 s, and coming back regrouped after ~3–6 s.

The **Detection** section shows an approximate distance next to each RSSI value (log-distance model: about -62 dBm at 1 m, path-loss exponent 2.2; under 0.5 m is shown as "< 0.5 m"). Bodies, pockets and walls shift RSSI a lot, so the figure can be off by a factor of two.

If one phone sees the other but not the other way round, check **Detection → Nearby phones** on the deaf phone. If the other phone is listed with a weak RSSI, lower "Near at". If no phone is listed at all, the phone's Bluetooth scanner is stuck (seen on MIUI after the app had been force-stopped several times): switch Bluetooth off and on, then restart approach mode.

### Calibrate

RSSI depends on both phones' antennas, cases and carrying positions, so fixed thresholds fit some phone pairs better than others. **Calibrate** (Approach tab, while approach mode is on) measures one signal (another phone, or in Master mode also a cap) for 5 s while standing together and 5 s at the distance that should count as away. It needs at least five reports per step and at least 6 dB between the two medians. **Away below** is set 2 dB above the away level, so that distance reliably counts as away; **Near at** sits between both levels, at least 3 dB (or 40 % of the difference) below the together level and at least 2 dB above "Away below". **Apply** stores both thresholds; nothing changes before that. In P2P mode your own cap is not offered, since it is worn by you and its distance does not change.

### Record and replay

**Record and replay** (Approach tab) records every detection input of this phone during a walk: RSSI of local caps, phone beacons, advertising caps, "something was heard" (at most once per second), motion magnitudes, cap list and settings changes. Tap **Together** and **Apart** when the wearers meet or part; these marks are the ground truth. Recording stops after 100 000 events. **Export** saves the walk as JSON (`format: "iledcolor-approach-trace"`, version 1); **Load** reads such a file and rejects it completely if any event is invalid. Traces contain RSSI values, device IDs, phone IDs and user names of nearby phones, but no location; share them only with people who may see this.

**Replay with current settings** feeds the walk into a fresh detection engine, ticking once per second like the app, once with the recorded settings and once with the current ones. It reports the number of group changes (and per minute), short flips (a change undone within 10 s), the delay from each "Together" mark until a group was shown and from each "Apart" mark until the caps were alone again, and the total time the caps showed a group while marked apart or were alone while marked together. This makes threshold, confirm and settle changes comparable on the same walk instead of re-walking it. The replay runs on the phone only; nothing is uploaded to caps.

### Sharing presets with nearby phones

In **Settings > Presets**, **Share** sends one preset (text, image, GIF, or group set) to another phone running the app. **Approach mode must be on for both phones.** The sharing service is the approach-mode GATT server, and the share list shows phones whose beacon this phone currently hears.

The receiver must accept the preset before anything is transferred:

1. The sender connects and writes a small offer to the share inbox characteristic (`…0020`). The offer includes the sender's name, the preset name and kind, the size, and a CRC-32C.
2. The receiver sees an **Accept / Decline** prompt. If nobody answers within 60 s, the offer is declined. Only one offer is open at a time, and further senders are told the receiver is busy.
3. The sender polls the status characteristic (`…0021`). It writes the preset data in single-write chunks only after the status shows **accepted**. The receiver ignores data for any transfer it has not accepted.
4. The receiver checks the size and CRC, validates the preset like a JSON import, and saves it as a new preset. Then it reports **received**.

Either side can cancel. Text presets transfer in a moment, while large GIF presets can take a few minutes over BLE. Keep the phones close until the transfer finishes.

### Limits and options for later

- RSSI is a rough distance proxy. Bodies, pockets, and orientation can shift it by 10–20 dB. Calibrate on site and compare settings with a recorded walk.
- On iOS, advertising works only while the app is in the foreground. The app keeps the screen awake while approach mode runs on both platforms.
- On Android, BLE scanning also asks for location permission, which the BLE plugin requests by default so beacon-style advertisements are not filtered. Nothing is stored or sent.
- Better ranging could use **UWB** (Pixel 9 Pro, iPhone 11+) or Nearby Connections / Multipeer Connectivity. Both need a session set up between phones. The beacon design above needs no pairing.

## Testing without hardware

Open the web app with `#mock` and open the **Approach** tab. Mock mode simulates caps and nearby phones, with RSSI sliders, so all tiers can be tried in a browser.

Motion classification, filter behavior for approach/departure/rotation, stale-data fallback, all three RSSI
sources, and native listener setup/cleanup are covered by automated tests, as are the median/time-weighted
filter, confirmation, radio-gap vs. fading expiry, mutual-near plausibility, marquee chains, calibration and
trace record/parse/replay. Mock mode also offers calibration (move a simulated phone's RSSI slider between
the two steps) and record/replay. Browser mock mode intentionally
does not read real sensors. Real-device sensor behavior and the heuristic thresholds still need validation
with different phones and carrying positions; no measured improvement in ranging accuracy is claimed.
