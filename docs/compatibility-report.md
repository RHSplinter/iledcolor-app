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
- Still to record: EndStream ack, brightness/display acks, larger chunk sizes, persistence after power cycle.
