"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = path.join(__dirname, "..", "src");
const read = file => JSON.parse(fs.readFileSync(path.join(src, file), "utf8"));
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join();
// lib/i18n.js is a plain script for the add-on's pages; run it to read its language list.
const context = { fetch: null, browser: null };
vm.runInNewContext(`${fs.readFileSync(path.join(src, "lib", "i18n.js"), "utf8")}\nthis.I18N = I18N;`, context);
const { LOCALES, match } = context.I18N;

test("every language has a complete catalog with the same placeholders", async () => {
  const { uiKeys } = await import("../scripts/i18n-keys.mjs");
  const keys = uiKeys();
  for (const code of LOCALES) {
    const catalog = read(`locales/${code}.json`);
    for (const key of keys) {
      const value = catalog[key];
      assert.ok(typeof value == "string" && value.trim(), `${code}: missing ${key}`);
      assert.equal(placeholders(value), placeholders(key), `${code}: ${key}`);
      assert.ok(!value.includes("—"), `${code}: em dash in ${key}`);
    }
    assert.deepEqual(Object.keys(catalog).filter(key => !keys.includes(key)), [], `${code}: keys no UI text uses`);
  }
});

test("every language has the manifest strings", () => {
  const en = Object.keys(read("_locales/en/messages.json")).sort();
  for (const code of LOCALES) {
    assert.deepEqual(Object.keys(read(`_locales/${code.replace("-", "_")}/messages.json`)).sort(), en, code);
  }
});

test("a language tag finds its catalog, a region falls back to the language", () => {
  assert.equal(match("pt-BR"), "pt-BR");
  assert.equal(match("pt"), "pt-BR");
  assert.equal(match("de-AT"), "de");
  assert.equal(match("zh_TW"), "zh-TW");
  assert.equal(match("en-US"), "en");
});
