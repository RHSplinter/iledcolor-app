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
5. In the browser (Bluefy browser for iPhone), navigate to https://xebia.github.io/github-universe-led-cap.
6. Press the connect button at the top of the page and connect to the Bluetooth name of the cap you discovered in step 2.
7. Familiarize yourself with the controls in the app and ask questions if you don't understand it. We have loaded the app with some presets you can use.

## Badge scanning

This app has a "Scan" tab that allows users to scan the conference badge text and use that to create an issue in GitHub. Follow these steps to make it work:

To scan without connecting a cap, choose **Scan without hat** next to **Connect**
on the start screen. This opens just the scanner, without navigation tabs or
greeting controls. Camera capture, on-device OCR, visitor editing, public GitHub
email lookup and saving a reviewed GitHub issue work without Bluetooth.
**Assign to (your GitHub username)** is available here and uses the same saved
value as Settings. In connected mode it appears only in Settings, not on the
Scan tab. Your username stays on this device and is excluded from backups. No
greeting is rendered or sent to a hat. **Return home** at the bottom stops the
camera and returns to the connection screen, where you can connect normally.
Reloading also returns to the start screen.

Scan-only mode is temporary running state, not a saved preference or backup
category. It does not change saved greeting, issue or logging settings. Scan
settings backups continue to include the greeting, issue destination and logging
preference (which can enable logging of personal data), but not scanned visitor
data, scan logs, device connections or the current mode.

For scanning with hat greetings and configuring scan settings:

1. Connect your cap to your phone.
2. Go to the settings tab.
3. Scroll down to the "Save scans as GitHub issues" section and fill your GitHub username in "Assign to (your GitHub username)".
4. Go to the "Scan" tab and click the "Scan" button.
5. Allow camera access.
6. Position the conference badge within the camera view to scan it. Ensure it's as close as possible to the lens, so "UNIVERSE'26" is outside the frame, as well as the visitor type (e.g. "Attendee").
7. Tap the "Capture text" button below the camera view.
8. Fill in remaining fields and click "Save".

## More docs

Go to:

* [README.md](docs/README.md)
* [INSTALL.md](docs/INSTALL.md)