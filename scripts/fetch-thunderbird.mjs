// Downloads an official Thunderbird build into .cache/ for the end-to-end test,
// so the test never starts a Thunderbird that is installed on this machine.
//
// Usage: node scripts/fetch-thunderbird.mjs [version]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_VERSION = "153.6.0esr";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function binaryFor(version = DEFAULT_VERSION) {
  return path.join(root, ".cache", "thunderbird", version, "core", "thunderbird.exe");
}

async function fetchThunderbird(version) {
  const binary = binaryFor(version);
  if (fs.existsSync(binary)) {
    return binary;
  }
  if (process.platform != "win32") {
    throw new Error("Only the Windows build is supported. Pass another binary to the test instead.");
  }
  const base = `https://archive.mozilla.org/pub/thunderbird/releases/${version}`;
  const name = `win64/en-US/Thunderbird Setup ${version}.exe`;
  const sums = await (await fetch(`${base}/SHA512SUMS`)).text();
  const expected = sums
    .split("\n")
    .find(line => line.endsWith(`  ${name}`))
    ?.split(" ")[0];
  if (!expected) {
    throw new Error(`No checksum for ${name} in ${base}/SHA512SUMS`);
  }
  const response = await fetch(`${base}/${encodeURI(name)}`);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.url}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(data).digest("hex") != expected) {
    throw new Error("Checksum mismatch, the download was discarded");
  }
  const dir = path.dirname(path.dirname(binary));
  fs.mkdirSync(dir, { recursive: true });
  const setup = path.join(dir, "setup.exe");
  fs.writeFileSync(setup, data);
  // Unpacks the program files only. Nothing is installed or registered. The
  // installer exits with 1 here even on success, so the result is checked below.
  spawnSync(setup, [`/ExtractDir=${dir}`]);
  fs.rmSync(setup);
  if (!fs.existsSync(binary)) {
    throw new Error(`Extraction did not produce ${binary}`);
  }
  return binary;
}

// Thunderbird's own fake IMAP server from its test suite, pinned to a
// comm-esr153 revision and checked by SHA-256. Only the e2e test loads it.
const FAKESERVER_REVISION = "77d93b020a0cb8874de3f1b1cb76dc1083607e58";
const FAKESERVER_FILES = {
  "Imapd.sys.mjs": "7595b2304f2509ec5a3e76bc72ddaab213b0bfc67c4f9bd65c9ad2e4bc56bba4",
  "Maild.sys.mjs": "7e279b8423d271641365e942d94a5e261029bda108286a6cae476036ecf9ac7c",
  "Auth.sys.mjs": "5fa27bff487818fc89faddb826d97fd2efc1ff82f4e0b58537029a67935ea410",
};
export const FAKESERVER_DIR = path.join(root, ".cache", "fakeserver");

export async function fetchFakeServer() {
  const dir = path.join(FAKESERVER_DIR, "mailnews");
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, sha256] of Object.entries(FAKESERVER_FILES)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && createHash("sha256").update(fs.readFileSync(file)).digest("hex") == sha256) {
      continue;
    }
    const url = `https://hg-edge.mozilla.org/releases/comm-esr153/raw-file/${FAKESERVER_REVISION}/mailnews/test/fakeserver/${name}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${url}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") != sha256) {
      throw new Error(`Checksum mismatch for ${name}, the download was discarded`);
    }
    fs.writeFileSync(file, data);
  }
  return FAKESERVER_DIR;
}

if (import.meta.url == pathToFileURL(process.argv[1]).href) {
  console.log(await fetchThunderbird(process.argv[2] ?? DEFAULT_VERSION));
  console.log(await fetchFakeServer());
}
