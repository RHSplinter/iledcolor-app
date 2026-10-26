# Led Hat

This is the Xebia Led hat used/introduced at GitHub Universe 2026.

## Getting started

> [!IMPORTANT]
> Ensure the cap is fully charged the day before use!!

> [!IMPORTANT]
> Do not use the app that comes with the cap. You don't need it and it is of Chinese origin.

1. If you have an iPhone, install the [Bluefy app](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055).
2. The cap is bluetooth-controlled and needs to be switched on by keeping the push-button pressed.

![on/off button](docs/img/cap-on-off-button.jpg)

3. When the cap is switched on, after the battery state is displayed, the unique Bluetooth name (4 character hex code) of the cap will be visible for pairing. If you missed it and the cap shows "WELCOME", turn it off and on again to see the Bluetooth name.

![Pairing code](docs/img/cap-connect-code.jpg)


4. If you have an Android device, you'll need it to allow bluetooth access in order to pair with the cap.
5. In the browser (Bluefy browser for iPhone), navigate to https://rhsplinter.github.io/iledcolor-app.
6. Press the connect button at the top of the page and connect to the Bluetooth name of the cap you discovered in step 2.
7. Open **Custom**, expand the content section you want, and use its **Send to cap** button to apply your changes.
   The app saves the exact hat ID and name in this browser's local storage. Refresh starts an automatic reconnect to that same hat and shows **Reconnecting to [hat name]** while Bluetooth rediscovers it. After at most 10 seconds, a failed attempt returns to normal **Connect** controls. The saved hat remains available for the next automatic attempt on refresh. Explicit **Disconnect** (click the connected status at the top) clears the saved hat. The browser may still label the hat as paired: permission is separate from an active connection.
   Automatic reconnect is optional. Without browser support, the app keeps the standard manual **Connect** flow. It detects the available Bluetooth APIs rather than requiring browser flags for everyone. Use the same browser profile and site address, and keep only one controller session open: a hat held by another tab or app may stop advertising.
8. Familiarize yourself with the controls in the app and ask questions if you don't understand it. We have loaded the app with some presets you can use.

## Optional automatic reconnect in Chrome / Edge

Manual connection works without experimental features. Automatic reconnect after refresh needs the browser to expose `navigator.bluetooth.getDevices()`; Bluetooth rediscovery can also use `BluetoothDevice.watchAdvertisements()`.

For users who choose to try this optional feature:

- Open `edge://flags` in Edge or `chrome://flags` in Chrome.
- Look for **Use the new permissions backend for Web Bluetooth**, if available. The browser may also require **Experimental Web Platform features** to expose the reconnect APIs. Flag availability varies by browser version; see the [Web Bluetooth implementation status](https://github.com/whatwg/bluetooth/blob/main/implementation-status.md).
- These are browser-wide experimental settings, not settings for this website alone. Restart the browser after changing them, then connect to the hat once to grant permission under the active configuration.
- On later refreshes the top status shows **Reconnecting to [hat name]** automatically, with no click or picker. If it cannot finish within 10 seconds, normal **Connect** controls return.
- If the required APIs remain unavailable, continue using manual **Connect**; the app does not open another window or tab.

## Custom content and backups

The **Custom** tab replaces Connect. **Text**, **Solid color**, **Image** and
**GitHub Contributions** each start collapsed; a right-pointing chevron expands a
section and turns down while it is open. Text scrolls automatically when it is wider than the cap,
supports emoji, and has its own font choice (or the Settings default). Images support
PNG, JPG and animated GIF, with contain, cover and stretch fitting.
The existing **Sequence** editor is available in its own collapsed section.

Each section has **Send to cap** and **Save as preset** controls. To save, enter a name
and select the adjacent check button. Load saved presets from Settings. GitHub presets
store the handle, captions, caption font and their own scroll speed. When the graph was loaded before
saving, the preset also keeps that graph and its date, so it can be shown, used in
sequences and shared without internet; load the graph again to refresh it. Presets
saved before loading a graph fetch a fresh graph each time they are shown, which
requires internet and sends that public handle to the contribution service.

**Settings > Backup > Creations** includes saved presets, all current Custom editor
drafts (even collapsed sections and image fit/background before choosing a file),
per-text fonts, sequences, and GitHub handle, captions, caption font and speed. Selecting all
categories backs up portable configuration across all tabs. Imports are saved
atomically, refresh the UI immediately, and survive reload. Excluded categories and
newer preferences absent from version-1 or older version-2 files are preserved.
Expansion state is not saved: sections always start collapsed.

Phone identity, cap connections/device IDs, permissions, running state, QR payloads,
and scan-log contents are not exported. The scan-logging preference belongs to
**Scan settings**; importing it can enable local scan logging.

## More docs

Go to:

* [README.md](docs/README.md)
* [INSTALL.md](docs/INSTALL.md)