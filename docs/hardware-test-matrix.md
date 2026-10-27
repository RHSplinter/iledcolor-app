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

## Windows browser reload reconnect (issue #19)

The original direct-reconnect approach could not restore the physical hat in the user's Edge configuration: the saved name/ID survived, but the saved-device browser API was unavailable. The current browser flow instead holds the Bluetooth link in a separate LED Hat Connection tab; no experimental flag is required.

1. Open the site. Verify the actions are Connect LED hat, Go to LED Hat Controller, Install app.
2. Choose Go without pairing. Verify Scan is selected and works without a hat; Sound is visible with its controls disabled.
3. Select Hat, then Connect hat. Verify the existing connection tab receives focus.
4. Select Connect LED hat and pair the physical device. Verify the controller receives focus with Hat selected, retaining any scan data.
5. Refresh the controller three times without reopening the picker. Verify the same hat is Ready and receives a command after each refresh.
6. Return to the connection tab and use Return. Verify it focuses the same controller without reloading. Close the controller and use Return again; verify a replacement attaches to the held link.
7. Disconnect in the controller. Verify Scan is selected and the owner reports disconnected. Go must select Scan even if the disconnected controller was left on Hat.
8. Close the connection tab. Verify Hat offers Connect hat; use it, pair again, and verify the existing controller is reused.
9. Install and launch the web app on desktop and mobile. Repeat pairing, controller refresh, and both tab directions. If automatic opening is blocked, Return must open the controller without another pairing.

Physical Windows Edge feedback on 2026-10-26: the user reported successful pairing and F5 recovery with the held connection tab. They then reported action ordering, disconnected navigation, and tab-return failures. Those navigation fixes require another physical review; physical BLE commands and mobile installation are not yet verified.

Automated validation uses a simulated hat for GATT and commands. It covers three controller refreshes with one picker/connection, tab reuse without document replacement, disabled Sound and local scanning without a hat, stale saved identity, and a blocked scripted opening followed by the normal Return link. The real Chromium/Edge chooser is separately exercised through a genuine click with test adapter emulation. Disposable installed-app tests exercise actual installation and standalone launch; they do not establish physical radio compatibility.
