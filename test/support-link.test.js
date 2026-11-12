"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

test("the settings page links to Ko-fi statically, without a widget script", () => {
  const html = readFileSync(path.join(__dirname, "../src/options/options.html"), "utf8");
  assert.match(html, /<a class="support-link" href="https:\/\/ko-fi\.com\/hypercrisis" rel="noreferrer" target="_blank">/);
  assert.doesNotMatch(html, /ko-fi\.com\/cdn|kofiwidget/);
});
