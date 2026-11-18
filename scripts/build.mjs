// Packs src/ into dist/allmail-buddy-<version>.xpi and points updates.json,
// the manifest's update_url, at that version's GitHub release asset.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
const { version } = manifest;
const { id, update_url, ...gecko } = manifest.browser_specific_settings.gecko;
const update = {
  version,
  update_link: `${manifest.homepage_url}/releases/download/v${version}/allmail-buddy-${version}.xpi`,
  applications: { gecko },
};
fs.writeFileSync(path.join(root, "updates.json"), JSON.stringify({ addons: { [id]: { updates: [update] } } }, null, 2) + "\n");
const out = path.join(root, "dist", `allmail-buddy-${version}.xpi`);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
const entries = fs.readdirSync(src);
if (process.platform == "win32") {
  // The bsdtar shipped with Windows writes zip archives.
  execFileSync("C:/Windows/System32/tar.exe", ["--format", "zip", "-cf", out, "-C", src, ...entries]);
} else {
  execFileSync("zip", ["-qr", out, ...entries], { cwd: src });
}
console.log(out);
