# Install and run

```
npm install
npm test            # encoder, controller, storage unit tests
npm run e2e         # Playwright against the production build, mocked hat
npm run build       # static site in dist/
```

## Deploy

Serve `dist/` from any static **HTTPS** origin (GitHub Pages, own host). Paths are relative, so
subdirectory hosting works. Web Bluetooth does not work over `file://` or plain `http://192.168.x.x`.

## Install on Android

1. Open the HTTPS URL in Chrome on the phone, wait for "Ready for offline use".
2. Tap **Install app** (or Chrome menu → Install app / Add to Home screen).
3. Later launches work with Wi-Fi/data off; only Bluetooth is needed.

Updates appear as a banner and are applied only when you tap Update (never during a transfer).

## First use on the hat

Read `docs/compatibility-report.md` and complete it before relying on the app. Start at a dim level,
use **Corner test**, fix orientation in Device settings, then tick "Dimensions verified".

Mock mode for development: open `/#mock`.

## Attribution

Protocol logic is ported from zagi/iledcolor_small (MIT, pinned at
`f68cb027c9f196dc4cb81fa8b39c8aaec97e737a`); license in `third_party/`. The text font is
Press Start 2P (OFL) via `@fontsource/press-start-2p`.
