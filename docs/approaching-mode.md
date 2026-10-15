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
| **Peer beacons**: other phones running the app | Each phone advertises a non-connectable BLE beacon and scans for others. The beacon is a 128-bit service UUID containing the magic `LEDHAT`, a version, the number of caps the phone controls, a random phone ID, and 16-bit hashes of up to two cap names. | One phone per wearer. The beacon carries the cap count, so a phone with 3 caps adds 3 to the group. This scales to large crowds (>10): each phone only listens and computes, and no connections are needed. |
| **Nearby caps**: caps advertising, not connected here | Scan results whose name starts with `iledcolor` | Caps that nobody has connected yet. Caps already counted through a peer beacon (name hash) are not counted twice. |

The service-UUID encoding exists because iOS can advertise only service UUIDs and a local name, not manufacturer data. The same beacon therefore works on both platforms.

### Hub mode vs. P2P mode

Both use the same Approach tab and engine; only the setup differs.

- **Hub ("master")**: one phone connects several caps; their proximity is the RSSI between that phone and each cap.
- **P2P**: every wearer runs the app on their own phone with their own cap connected and starts Approach mode.
  Phones detect each other through the `LEDHAT` beacon; each phone only uploads to its own cap.
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

- RSSI is smoothed with an exponential moving average. The app uses hysteresis with defaults: **near ≥ -70 dBm** and **away < -80 dBm**. These thresholds can be set in the app. Entries without updates expire after 8 s.
- A changed group must stay stable for the **settle time** (2 s by default) before caps are updated. This stops flicker at the edge of the range.
- Every phone sorts the group the same way (by phone ID, then cap index), so all phones agree on the left-to-right order of a spanning marquee and on who is "first".
- The **Approach mode switch** (Approach tab, below your name) turns scanning, the phone beacon and the automatic uploads on and off. The phone remembers it: if the switch was on when the app closed, the next app start reconnects the saved caps and resumes approach mode on its own.
- **Your name** (Approach tab, top) is the human-readable name of this phone's wearer. It is saved on the phone and used as the label of your caps ("Anna", "Anna2", …) unless you rename a cap. It is also sent to other phones next to the beacon UUID: Android puts it in the scan response as manufacturer data (company ID `0xFFFF`, prefix `LH`, at most 20 UTF-8 bytes, so ~10 umlauts or 20 ASCII letters), and iOS sends it as the advertised local name. Other phones show it in the group pills and the "Nearby phones" list and greet with it ("Hi Anna!"). Without a name, a phone falls back to a deterministic animal name derived from its phone ID ("Fox", "Owl2", …), which every phone computes the same way. If your first cap has its own label, that label is sent instead, so all phones use the same text for span marquees.
- Local caps that are not near get the "1 cap" content.

### Span mode

The text is rendered once as a wide strip. Each cap gets its slice as a looping animation with the same frame count and timing, at most 120 frames to stay within the cap's 64 KB transfer limit. Uploads to caps on the same phone run in parallel. Across phones, the start is aligned only by the shared settle time, so the marquee is close but not frame-accurate.

### Troubleshooting P2P

Tested with two real phones (Pixel 9 Pro and Xiaomi with MIUI / Android 12), one cap each. Both formed a group of 2 within seconds and greeted each other by user name. Walking away returned each cap to its solo content after ~12 s, and coming back regrouped after ~3–6 s.

If one phone sees the other but not the other way round, check **Detection → Nearby phones** on the deaf phone. If the other phone is listed with a weak RSSI, lower "Near at". If no phone is listed at all, the phone's Bluetooth scanner is stuck (seen on MIUI after the app had been force-stopped several times): switch Bluetooth off and on, then restart approach mode.

### Limits and options for later

- RSSI is a rough distance proxy. Bodies, pockets, and orientation can shift it by 10–20 dB. Tune the thresholds on site.
- On iOS, advertising works only while the app is in the foreground. The app keeps the screen awake while approach mode runs on both platforms.
- On Android, BLE scanning also asks for location permission, which the BLE plugin requests by default so beacon-style advertisements are not filtered. Nothing is stored or sent.
- Better ranging could use **UWB** (Pixel 9 Pro, iPhone 11+) or Nearby Connections / Multipeer Connectivity. Both need a session set up between phones. The beacon design above needs no pairing.

## Testing without hardware

Open the web app with `#mock` and open the **Approach** tab. Mock mode simulates caps and nearby phones, with RSSI sliders, so all tiers can be tried in a browser.
