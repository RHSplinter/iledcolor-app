# UI improvements - 0.2.1

## Requested navigation changes

The tab order is Connect, Approach, Scan, Settings. All four tabs have locally bundled
SVG icons; Settings uses only a gear, with an accessible name and tooltip.
The previous Presets destination is now Settings, at the far right.
The empty Create tab has been removed.

Connect contains the original connection controls followed by the complete content editor:
text, scroll speed, foreground/background colour, solid colour, image/GIF input and fit,
preview, send/cancel/progress, and preset saving.

Settings retains the preset list, content/group preset loading and deletion, native BLE
sharing, all three backup categories, share/import, and storage status. It also contains
everything previously below the connection card: Display, Test patterns, Protocol log,
and Device settings. Test patterns and Protocol log are expandable native disclosures;
their controls and live updates remain mounted. Brightness, display power, transforms,
chunk size and write delay keep their existing persistence and connection semantics.

Scan starts with scan/stop/end-greeting controls, video and status. All profile, regex,
greeting, manual-input, logging, sharing, privacy and attribution features remain available.
Marquee options in all five Approach group sizes, the simulated-peer selector, nearby
text mode labels and span status are explicitly marked unstable. Selecting a spanning
mode shows a warning without changing or disabling its behaviour.

## UI/UX expert review and decisions

After the requested rearrangement, a dedicated UI/UX designer agent reviewed the source
in a read-only pass. Its main findings and the implemented changes are:

| Finding | Implemented response |
| --- | --- |
| Navigation needs clear location and keyboard support | Four labelled tab panels, roving tab focus, arrows/Home/End, selected background and top marker, visible Settings heading. |
| Touch controls and muted text lack consistency | At least 44 px fields, sliders and colour inputs; 48 px primary buttons; large checkbox/radio labels; readable muted pills, field borders and placeholders; consistent focus/hover/pressed states. |
| Narrow forms and long names can overflow | Responsive numeric-field grids, shrinking flex children, full-width mobile preset-save rows, wrapping preset names/status messages, bounded file inputs and transfer notifications. |
| Scan mixes immediate actions and configuration | Operation first, then separately titled QR profile, greeting, and log/privacy sections; disabled-action prerequisites shown beside the scanner actions. |
| Connect lacks feedback and clear preset input | Visible preset-name labels, send-prerequisite help, named upload progress and live completion status. |
| Settings diagnostics dominate ordinary tasks | Presets/backup and Display stay prominent; test patterns/log are expandable without removing any controls. |
| Renamed tabs leave stale sharing references | Incoming preset receipt refreshes Settings; group help and content references use the actual destination names. |
| Incoming sharing surface was labelled as a dialog without dialog focus behaviour | It is a named, non-modal live region so Accept/Decline remain keyboard-accessible without stealing focus during live operation. |

The existing dark, blue-accent identity and 560 px content measure are preserved.
Spacing uses a small shared scale. Switch animation respects reduced-motion preferences.
Approach detection, calibration and recording remain directly exposed rather than adding
new disclosure state during live rerenders. No BLE, rendering, scanner, storage or backup
features were removed. Internal `createContent`/`useCreate` keys are intentionally retained
for compatibility with existing installations and backups.

## Verification and delivery

Regression coverage includes the existing offline, content, group, sharing-category,
QR-camera, profile and scan-log scenarios. Additional navigation coverage checks tab order,
icons, content/preset destinations, relocated display/test/log controls, persisted device
settings, keyboard navigation, all marquee labels/warnings, and scan-first ordering.
Layout assertions cover 360 px and 390 px portrait, 844 px landscape, 1280 px desktop,
60-character preset names and doubled body text.

The release is 0.2.1 (Android/iOS build 2002), synchronized by the existing version script.
The release-workflow test normalizes CRLF before extracting its Bash block so the same
checks run on Windows and Linux. Android publication uses the existing signed GitHub
Actions release workflow and a matching `v0.2.1` tag, not an unsigned/debug fallback.

The first tagged build exposed an SDK provisioning failure before compilation:
`android-actions/setup-android@v3` defaults to `tools platform-tools`, but Google's SDK
repository no longer supplies the legacy `tools` package. The workflow now requests
`platform-tools` explicitly, while keeping the explicit Android 36 / build-tools 35
installation. A regression test covers that package selection. The failed release tag
is not moved: after merging the workflow correction, a manual run of the corrected
workflow from main can build the unchanged `v0.2.1` application sources.

## iOS and web follow-through - 0.2.2

Android, iOS and the PWA consume the same `index.html`, `src/ui/main.ts` and
`src/ui/style.css`. The native release workflows build that source and run Capacitor
sync before packaging. No forked iOS layout or hand-edited generated web bundle is
needed. Safe-area padding now protects the content edges in landscape, in addition
to the existing status and bottom-tab insets.

The production web app shows Connect, Scan and Settings. Approach remains available
in both native apps, including every unstable-Marquee warning, and in `#mock` for
development. The hidden tab is excluded from keyboard traversal and cannot be opened
programmatically through the shared navigation helper. Web keeps supported BLE
control, offline editing, all content types, display settings, diagnostics, QR scanning
and manual entry, storage, JSON sharing/import and profiles. Browser Bluetooth and
camera prerequisites still apply.

Imported group presets remain stored and exportable on web; their Load buttons are
disabled with a visible native-app explanation. Backup categories are deliberately
unchanged so moving a backup through the browser cannot discard native settings.
The browser never exposes the nearby-phone BLE Share action. Empty-state guidance no
longer directs web users to a nonexistent Approach destination.

### Native icon direction

The web app's six coloured LEDs are retained as the family resemblance, while a blue
cap outline and brim distinguish the installed apps. The PWA icon is unchanged.
`scripts/make-icons.mjs` produces the vector reference and all native PNG sizes from
one set of shape coordinates, without external fonts, image downloads or dependencies.
Android adaptive foregrounds have transparency and a separate dark background; the
artwork is inset into the safe circle. Legacy square and round variants cover older
launchers. The iOS universal icon is 1024 px RGB with no alpha channel; iOS supplies
the outer mask.

`e2e/platforms.spec.ts` covers real web navigation/offline editing and the iOS/Android
shell layout selected through a simulated Capacitor platform. Those shell tests do
not claim to exercise native hardware. Icon tests verify reproducibility, density
sizes, all six LED colours, iOS opacity and the Android adaptive safe circle.

Version 0.2.2 uses native build 2003 on both platforms. Both native web bundles were
built and synchronized successfully on Windows. iOS compilation/signing still requires
macOS/Xcode and the existing optional Apple signing configuration; no IPA or physical
iPhone behaviour is claimed from the browser shell checks.
