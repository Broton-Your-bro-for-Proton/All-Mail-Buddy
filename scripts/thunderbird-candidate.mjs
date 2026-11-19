// Checks Mozilla's version list for a Thunderbird release above the add-on's
// strict_max_version. If one exists, raises the cap to that major version,
// bumps the add-on's patch version and prints the versions to test against
// as GitHub Actions outputs. Prints nothing when there is nothing new.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(root, "src", "manifest.json");
const packageFile = path.join(root, "package.json");

const versions = await (await fetch("https://product-details.mozilla.org/1.0/thunderbird_versions.json")).json();
const latest = versions.LATEST_THUNDERBIRD_VERSION;
const esr = versions.THUNDERBIRD_ESR;
const major = v => parseInt(v, 10);

const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const gecko = manifest.browser_specific_settings.gecko;
if (!latest || major(latest) <= major(gecko.strict_max_version)) {
  process.exit(0);
}

const [a, b, c] = manifest.version.split(".").map(Number);
manifest.version = `${a}.${b}.${c + 1}`;
// Edits the text in place so the files keep their own formatting.
const setVersion = text => text.replace(/("version": )"[^"]+"/, `$1"${manifest.version}"`);
fs.writeFileSync(
  manifestFile,
  setVersion(fs.readFileSync(manifestFile, "utf8")).replace(
    /("strict_max_version": )"[^"]+"/,
    `$1"${major(latest)}.*"`
  )
);
fs.writeFileSync(packageFile, setVersion(fs.readFileSync(packageFile, "utf8")));

const out = { latest, esr, major: major(latest), version: manifest.version };
const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
console.log(lines.trim());
