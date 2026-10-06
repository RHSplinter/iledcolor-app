# Hardware test matrix (all rows pending)

Automated coverage (`npm test`, `npm run e2e`) uses a mocked transport and cannot prove hardware compatibility.

| Gate | Phone / Android / Chrome | Result | Notes |
|---|---|---|---|
| Hardware match (handshake + asymmetric image) | | pending | |
| Red / green / blue, corners, text | | pending | |
| Brightness levels 0..10 mapping; display off/on | | pending | |
| 20 consecutive static uploads (phone 1) | | pending | time per upload: |
| 20 consecutive static uploads (phone 2) | | pending | if only one phone, state that here |
| Offline: install, close, Wi-Fi/data off, relaunch, edit preset, connect, upload | | pending | |
| Lock/unlock, range loss, hat power cycle, other app holding the link | | pending | |
| Update during idle only; presets survive update | | pending | |
| No app network requests in a control session | | pending | e2e covers the mock session only |
| Animation (not shipped) | | n/a | |
