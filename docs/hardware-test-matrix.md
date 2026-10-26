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

Use one Edge/Chrome tab on the same origin throughout the test. Apply any pending app Update before testing a new build.

1. Connect to a physical hat. Verify the full name in the header.
2. Press F5. Without opening the picker, verify the header immediately shows Reconnecting to the remembered name, then Ready with that same name.
3. Repeat three times, and verify a command still reaches the hat after reconnect.
4. With a different authorized hat available, verify reload still targets only the saved ID.
5. Switch the saved hat off and reload. Verify progress and a useful failure message; the ID/name must remain saved. The attempt must stop within 10 seconds and restore normal Connect controls. Switch it on and refresh again; it should reconnect without a picker.
6. Open the connected status menu and Disconnect. Reload must remain disconnected. Connect may now show the picker, which can still label previously authorized devices as paired.

Local validation on Windows, 2026-10-26: 452 unit tests and the production build pass. Simulated browser tests cover automatic refresh, exact-ID selection, visible progress, ten-second timeout, and explicit disconnect. The physical Edge session retained iledcolor-231B in local storage but reported that getDevices() was unavailable. Automatic physical reconnect is therefore blocked in this browser configuration; seeing Ready during an earlier interactive session did not establish an automatic-reconnect pass. The full browser run also exposed a badge-greeting failure in the existing mock keepBlack test, outside the browser-reconnect path.

## Connection tab fallback (no experimental reconnect API required)

- Select Keep Bluetooth in an LED Hat Connection tab, then Connect.
- Verify the new tab is titled LED Hat Connection and explains that it owns the hat link and must remain open.
- Choose the physical hat once in that tab; verify focus returns to the main app.
- Refresh the main app three times without selecting Connect or reopening the picker. Verify the same hat is ready and can receive a command after each refresh.
- Disconnect in the main app; verify the connection tab reports disconnected and the remembered identity is cleared.
- Close the connection tab and refresh the main app. It must return to Connect within 10 seconds.

Automated tests pass for the held-link flow with getDevices deliberately unavailable, including three main-page refreshes with exactly one picker and one GATT connection. Physical Windows verification remains pending.
