// The UI texts of the add-on, as the catalogs in src/locales/ need them: every t("...") key in the
// scripts and the static text of the pages. `node scripts/i18n-keys.mjs` prints them as JSON.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (["locales", "_locales"].includes(e.name) ? [] : files(path.join(dir, e.name))) : [path.join(dir, e.name)]));
const pageText = text => text.trim().replace(/\s+/g, " ");

export function uiKeys() {
  const keys = new Set();
  for (const file of files(src)) {
    const text = readFileSync(file, "utf8");
    if (file.endsWith(".js")) {
      for (const m of text.matchAll(/\bt\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
        keys.add(m[1][0] == "'" ? m[1].slice(1, -1).replace(/\\'/g, "'") : JSON.parse(m[1]));
      }
    } else if (file.endsWith(".html")) {
      const markup = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "");
      for (const m of markup.matchAll(/>([^<>]*)</g)) {
        const key = pageText(m[1]);
        if (/[A-Za-z]/.test(key)) {
          keys.add(key);
        }
      }
      for (const m of markup.matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)) {
        if (/[A-Za-z]/.test(m[1])) {
          keys.add(m[1]);
        }
      }
    }
  }
  // The manifest's texts, translated into src/_locales/<code>/messages.json.
  for (const { message } of Object.values(JSON.parse(readFileSync(path.join(src, "_locales", "en", "messages.json"), "utf8")))) {
    keys.add(message);
  }
  return [...keys].sort();
}

if (process.argv[1] == fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(uiKeys(), null, 1));
}
