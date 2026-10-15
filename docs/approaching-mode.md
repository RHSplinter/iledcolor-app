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
own slice locally. Slice order follows phone IDs (not physical left/right) and start times are only roughly aligned.

Hardware check (Pixel 9 Pro, release APK, one cap per phone): with only cap A connected, the phone grouped the
still-unconnected cap B (2 caps → greeting uploaded to cap A). Connecting cap B elsewhere (it stops advertising, as when
another phone takes it) returned cap A to the solo content after ~9 s; releasing cap B brought the greeting back after
~7 s. The phone-to-phone beacon path is covered by unit and mock tests; it still needs a run with two app phones.

### Proximity and grouping

- RSSI is smoothed with an exponential moving average. The app uses hysteresis with defaults: **near ≥ -70 dBm** (≈ 2 m) and **away < -75 dBm** (≈ 4 m), so a cap is put back to its alone content before it is really out of Bluetooth range — useful in Master mode, where a cap walking away stays connected for a long time. These thresholds can be set in the app; the **Away beyond 3 m / 4 m / 5 m** buttons set the away threshold from a distance. Saved settings with the old -80 dBm default are moved to -75 dBm. Entries without updates expire after 8 s.
- **Symmetric proximity**: two phones rarely receive each other equally well (antennas, pockets, a throttled scan). A peer therefore also counts as near when this phone still hears its beacon and the peer's near mask lists this phone. The mask only uses each phone's own reception, so the rule cannot latch; both phones enter and leave the group together. The "Nearby phones" list shows such peers as "near (sees you)".
- **Keep-alive**: the beacon is re-advertised every 10 s and whenever its content changes, because some phones stop advertisers silently. The scan is restarted every 4 minutes, since some phones (for example Xiaomi, with a 5-minute `scan_timeout`) quietly downgrade long-running scans, and also after 15 s without any received advertisement. Caps and phones that are already near are kept for twice `staleMs` (16 s by default) after they were last heard, so short radio gaps (scan restarts, missed advertisements) do not split a group.
- A changed group must stay stable for the **settle time** (2 s by default) before caps are updated. This stops flicker at the edge of the range.
- Every phone sorts the group the same way (by phone ID, then cap index), so all phones agree on the left-to-right order of a spanning marquee and on who is "first".
- **Mode** (Approach tab, changeable while approach mode is off): **P2P** (default) uses one cap per phone and always advertises the phone; the multi-cap controls (Add cap, saved caps, order, beacon and nearby-cap checkboxes) are hidden. **Master** lets one phone control several caps and shows those controls. Switching to P2P disconnects all caps except cap 1 (the saved list is kept).
- The cap connected on the **Connect tab** is cap 1 of the Approach tab (one shared connection): connecting there adds it in front (or moves it to the front), "Disconnect" there disconnects cap 1 and stops its automatic reconnect, and the Create tab sends to it.
- The **Approach mode switch** (Approach tab, below your name) turns scanning, the phone beacon and the automatic uploads on and off. Switching off also restores the configured **1 cap (alone)** content on every connected local cap, after any in-flight group upload finishes; it does not leave a greeting or a span segment on the cap. Keep the caps connected until this reset finishes. The phone remembers the switch: if it was on when the app closed, the next app start reconnects the saved caps and resumes approach mode on its own.
- **Your name** (Approach tab, top) is the human-readable name of this phone's wearer. It is saved on the phone and used as the label of your caps ("Anna", "Anna2", …) unless you rename a cap. It is also sent to other phones next to the beacon UUID: Android puts it in the scan response as manufacturer data (company ID `0xFFFF`, prefix `LH`, at most 20 UTF-8 bytes, so ~10 umlauts or 20 ASCII letters), and iOS sends it as the advertised local name. Other phones show it in the group pills and the "Nearby phones" list and greet with it ("Hi Anna!"). Without a name, a phone falls back to a deterministic animal name derived from its phone ID ("Fox", "Owl2", …), which every phone computes the same way. If your first cap has its own label, that label is sent instead, so all phones use the same text for span marquees.
- Local caps that are not near get the "1 cap" content.
- Under **1 cap (alone)**, enable **Use Create tab content** to use the current text, solid color, image or GIF from Create instead of the solo Approach template. This content returns when the caps separate or approach mode is switched off. The Create content and the choice are remembered across restarts. Group presets include the choice; the referenced Create content stays local to each phone and can be transferred separately as a normal content preset.
- **Group content presets:** "Save as preset" below "Content per group size" stores the content of all five group sizes under a name. It appears on the Presets tab as "group content". **Load** applies it in the Approach tab; if approach mode is on, the new content is sent to the caps. Group presets are in the JSON export/import together with the normal presets (field `groups` instead of `content`; the export version stays 1). Import validates all group sizes strictly and rejects the whole file on any error.

### Span mode

The text is rendered once as a wide strip. Each cap gets its slice as a looping animation with the same frame count and timing, at most 120 frames to stay within the cap's 64 KB transfer limit. Uploads to caps on the same phone run in parallel. Across phones, the start is aligned only by the shared settle time, so the marquee is close but not frame-accurate.

### Troubleshooting P2P

Tested with two real phones (Pixel 9 Pro and Xiaomi with MIUI / Android 12), one cap each. Both formed a group of 2 within seconds and greeted each other by user name. Walking away returned each cap to its solo content after ~12 s, and coming back regrouped after ~3–6 s.

The **Detection** section shows an approximate distance next to each RSSI value (log-distance model: about -62 dBm at 1 m, path-loss exponent 2.2; under 0.5 m is shown as "< 0.5 m"). Bodies, pockets and walls shift RSSI a lot, so the figure can be off by a factor of two.

If one phone sees the other but not the other way round, check **Detection → Nearby phones** on the deaf phone. If the other phone is listed with a weak RSSI, lower "Near at". If no phone is listed at all, the phone's Bluetooth scanner is stuck (seen on MIUI after the app had been force-stopped several times): switch Bluetooth off and on, then restart approach mode.

### Limits and options for later

- RSSI is a rough distance proxy. Bodies, pockets, and orientation can shift it by 10–20 dB. Tune the thresholds on site.
- On iOS, advertising works only while the app is in the foreground. The app keeps the screen awake while approach mode runs on both platforms.
- On Android, BLE scanning also asks for location permission, which the BLE plugin requests by default so beacon-style advertisements are not filtered. Nothing is stored or sent.
- Better ranging could use **UWB** (Pixel 9 Pro, iPhone 11+) or Nearby Connections / Multipeer Connectivity. Both need a session set up between phones. The beacon design above needs no pairing.

## Testing without hardware

Open the web app with `#mock` and open the **Approach** tab. Mock mode simulates caps and nearby phones, with RSSI sliders, so all tiers can be tried in a browser.
