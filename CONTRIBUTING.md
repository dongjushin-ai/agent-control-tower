# Contributing

Thanks for helping. A few ground rules keep this project small and easy to trust:

- **No runtime dependencies.** The CLI is `bin/tower.mjs`, the shared logic is `dashboard/tower-core.js` (UMD, used by both Node and the browser).
- **No external requests from the dashboard.** No CDNs, web fonts or analytics.
- **The record format is a contract.** Changes to `v: 1` must stay backward compatible; anything else needs a new version and a migration note.
- **Tests first.** `npm test` runs everything with Node's built-in test runner (Node 20+). Add a test with every fix.
- UI strings live in `dashboard/index.html` (`UI.en` / `UI.ko`) and `tower-core.js` (`STRINGS`). A test checks that both languages have the same keys.

Good first issues: new snippet for an agent framework you use, a log adapter, translations.

Please don't paste real logs that contain personal data or secrets into issues; the demo data generator (`demoData` in `tower-core.js`) is there for reproductions.
