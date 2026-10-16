# Compatibility report (milestone 1) — NOT YET COMPLETED

The app is built against the **reference** iLEDColor profile. Nothing below is verified on the
supplied hat (ASIN B0BZD3W1XY) until a human fills it in on real hardware. **Go/no-go: undecided.**

## Steps (README §1)

1. Box/manual QR code → companion app: `________`; hardware label: `________`; stated resolution: `________`
2. nRF Connect (read-only): advertised name `________`; service UUIDs `________`
3. GATT comparison

   | Purpose | UUID | Expected property | Observed |
   |---|---|---|---|
   | Service | `0000a950-…` | primary | |
   | Commands | `0000a951-…` | write w/o response | |
   | Stream | `0000a952-…` | write w/o response | |
   | Acks | `0000a953-…` | notify | |

4. Spike in the app (Connect tab, start dim): handshake ack bytes `________`; password byte `________`
5. Corner test: dimensions `__ x __`; orientation/mirroring needed `________`; RGB order OK? `____`
6. Usable chunk size / write delay `________`; do chunk acks arrive? `____`; max stream bytes `________`
7. Persists after disconnect? `____` After power cycle? `____`

## Decision

- [ ] GO: handshake accepted and asymmetric image rendered correctly.
- [ ] NO-GO: other protocol / Bluetooth Classic → stop iLEDColor writes; see README §1 last paragraph.

After GO, set `dimensionsVerified`, and put the tested chunk size/delay in Device settings.
Observed ack formats that differ from the app's assumptions (below) must be recorded here, not hidden.

## Assumptions the app makes about acks (verify!)

- Every ack echoes the command byte of the request (0x0d, 0x0f, 0x06, 0x00, 0x01, 0x09, 0x0a).
- Continue acks, if they carry ≥4 body bytes, start with the 4-byte chunk sequence number.
- TestPass status = last body byte: `0x00/0x01/0x03` accepted, `0x02` denied, anything else error.

## Observed on the real hat (first log, chunk size 8, 10 ms delay)

- Connect ack `540d000400000065`; TestPass ack `540f0003030069` (status 0x03 = no password set).
- StartStream ack `5406000301005e`.
- Continue ack `540000050000000001005a`: body = seq(4) + status 0x01. **Deviation:** its length field
  (5) excludes the checksum, unlike all other acks. The parser accepts this form for cmd 0x00 only.
- While charging, uploading normal content/animation from the app replaces the hat's built-in
  charging animation (confirmed by user on hardware). Whether the charging animation returns on
  re-plugging is not yet recorded.
- Still to record: EndStream ack, brightness/display acks, larger chunk sizes, persistence after power cycle.

## Battery-service inspection (2026-10-16, Pixel 9 Pro)

- Connected to `iledcolor-947F` and enumerated GATT services without sending control commands.
- Services: `1800` (Generic Access), `A950` (iLEDColor), and `AE00` (vendor-specific).
- `1800` exposes readable/writable device name `2A00`; `A950` exposes write-without-response
  `A951`/`A952` and notify `A953`; `AE00` exposes write-without-response `AE01` and notify `AE02`.
- No standard Battery Service `180F` or Battery Level characteristic `2A19` is exposed.
  Standard battery-level reads therefore cannot provide a percentage on this hat.
- `AE00` carries the encrypted JieLi-style challenge/response channel (see `zagi/iledcolor_small`
  `docs/protocol.md`); it is undecoded and not usable for queries.
- Vendor app `com.led.iledcolor` v1.0.59, connected to `iledcolor-947F`, shows no battery level
  anywhere: scan list (name, `16x32`, RSSI only), home screen, settings, and "Geräteinformationen"
  (screen size `16*32`, colour type `3`, firmware `11`, serial `6`, uuid). The open-source
  references (`zagi/iledcolor_small`, `winnerplace/ha-iledcolor-led-matrix`) have no battery command.
- Conclusion: no known way to read the battery level from this hat, so the app does not show one.
