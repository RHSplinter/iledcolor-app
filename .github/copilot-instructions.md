# Preset backup coverage

Preset export/import is a selectable backup of configuration across all tabs, not
just saved content presets. Whenever adding or changing a feature setting:

- Include it in the appropriate category in `src/storage/sharedBackup.ts`, and
  expose a clearly labelled category in Settings if none fits. Selecting all
  categories must cover all portable configuration, including current editor
  values, not only named presets.
- Wire export, strict import validation, atomic IndexedDB persistence, immediate
  UI/runtime refresh, and restoration after reload. Preserve excluded categories
  and fields absent from older files; keep version-1 and older version-2 backups
  importable without silently resetting newer preferences.
- Add round-trip, category-exclusion, invalid-input, persistence/rollback, and
  relevant end-to-end coverage. Update the backup documentation in README.md.
- Do not export phone identity, cap connections/device IDs, OS permissions, live
  running state, QR payloads, or scan-log contents. The scan-logging preference is
  configuration and belongs to Scan settings; make its privacy consequence clear.
