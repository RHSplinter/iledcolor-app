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

## More docs

### Scanning and backups

Scanned visitor fields include an editable **Email address** and **Phone number**,
each with a fixed field type.
Recognized GitHub handles are automatically sent to the public GitHub API to find
a public email. If none is available (or the lookup fails), the email stays empty
for manual entry. A lookup never overwrites a manually edited email. The email is
validated when you leave the field: an invalid address is outlined in red and
**Save** stays disabled until it is corrected or cleared. The phone number is
filled from scanned data when present and is never looked up online.

**Scan log & privacy** is at the bottom of **Settings**. Logging is off by default;
enabling it saves personal scan data, including any public email, locally.

Settings backups are selectable across tabs. **Scan settings** includes proximity
thresholds, timing, current greeting, repetitions, speed, and the logging preference,
but never scan-log contents or scanned visitor data. Excluded categories and fields
absent from older backups are preserved. Version-1 and older version-2 backups
remain importable; their former GitHub lookup toggle no longer affects automatic
lookup and is omitted from new exports. Phone identity, cap connections/device IDs,
OS permissions, running state, and QR payloads are not exported.

Go to:

* [README.md](docs/README.md)
* [INSTALL.md](docs/INSTALL.md)