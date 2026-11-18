# Agent notes

- Language for code, comments, UI texts, commits and docs: American English.

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
