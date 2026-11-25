# Agent notes

- Language for code, comments, UI source texts, commits and docs: American English.
- The UI is translated into the store's 56 languages (`LOCALES` in `src/lib/i18n.js`). English is the key in `t("...")`; each language has `src/locales/<code>.json` and `src/_locales/<code>/messages.json`. The experiment gets the catalog with its config. Every new UI text gets an entry in every catalog; `npm test` fails otherwise (`scripts/i18n-keys.mjs`, `test/i18n.test.js`). The diagnostics log stays English.

## README style

- Centered icon on top, title, bold tagline, one badge row (at most six).
- Every `##` heading starts with an emoji. Fixed ones: ✨ Features,
  📦 Installation, 🚀 Usage, ⚙️ Configuration, 🖼️ Screenshots,
  🩺 Troubleshooting, 💬 Support, 🙏 Credits, 📄 License. Other sections get
  a fitting emoji of their own, never one twice per file.
- Install path first, features as bullets, configuration as a table, one
  screenshot when there is a UI, GitHub alerts for warnings.
- Badges are static shields.io badges; keep their values (Thunderbird
  version, status) in sync with the manifest.

## Releases

- Bump `version` in `src/manifest.json` and `package.json`, run
  `npm run build` and commit the regenerated `updates.json` in the same PR.
- After the merge, publish a GitHub release `v<version>` with
  `dist/allmail-buddy-<version>.xpi` attached. Installed copies update from
  `updates.json` on `main` (the manifest's `update_url`).

## Upstream automation

| Upstream | Kind | Intake | Release |
|---|---|---|---|
| Thunderbird (product-details.mozilla.org) | Dependency (host application) | `.github/workflows/thunderbird-update.yml`, daily on Windows, candidate PR from `automation/thunderbird-<major>` to `main` | Automatic through `.github/workflows/release.yml` |

- Protected features: everything the add-on does in All Mail is proven by
  `test/e2e/run.mjs`, run against the new Thunderbird release and the
  current ESR on the exact candidate; `npm test` covers the pure logic.
- Agent run: `.github/workflows/update-agent.yml`, daily, only when a
  candidate, a failed intake run or an unreleased version waits. It repairs
  add-on code, merges its own fix PRs and releases only through
  `release.yml`.
- Recovery: run `release.yml` again with the same `pr` and `run_id`.
- Pause: repository variable `UPDATE_AGENT=false`.
- Releases made by this automation need no confirmation. Everything else
  that touches the release path does.
