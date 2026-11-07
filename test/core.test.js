"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isBridgeRoot, classify, LocationIndex } = require("../src/lib/core.js");

test("detects a Bridge account root", () => {
  assert.ok(isBridgeRoot(["INBOX", "All Mail", "Folders", "Labels"]));
  assert.ok(isBridgeRoot(["All Mail", "Labels"]));
  assert.ok(!isBridgeRoot(["INBOX", "All Mail"]));
  assert.ok(!isBridgeRoot(["INBOX", "[Gmail]"]));
});

test("classifies Bridge folders", () => {
  assert.deepEqual(classify(["All Mail"]), { kind: "allmail", name: "All Mail" });
  assert.deepEqual(classify(["Folders"]), { kind: "container", name: "Folders" });
  assert.deepEqual(classify(["Labels"]), { kind: "container", name: "Labels" });
  assert.deepEqual(classify(["Starred"]), { kind: "label", name: "Starred" });
  assert.deepEqual(classify(["Labels", "Work", "Urgent"]), { kind: "label", name: "Work/Urgent" });
  assert.deepEqual(classify(["Folders", "Finanzen", "Paypal"]), { kind: "real", name: "Finanzen/Paypal" });
  assert.deepEqual(classify(["INBOX"], ["Inbox"]), { kind: "real", name: "Inbox" });
  assert.deepEqual(classify(["Trash"]), { kind: "real", name: "Trash" });
});

function sampleIndex() {
  const index = new LocationIndex();
  index.setFolder("inbox", { kind: "real", name: "Inbox" }, [{ key: 1, id: "a@x", size: 100, date: 5 }]);
  index.setFolder("fin", { kind: "real", name: "Finanzen" }, [{ key: 7, id: "b@x", size: 200, date: 6 }]);
  index.setFolder("sent", { kind: "real", name: "Sent" }, [
    { key: 3, id: "self@x", size: 300, date: 7 },
    { key: 4, id: "twin@x", size: 400, date: 8 },
  ]);
  index.setFolder("inbox2", { kind: "real", name: "Inbox2" }, [
    { key: 9, id: "self@x", size: 310, date: 7 },
    { key: 10, id: "twin@x", size: 400, date: 8 },
  ]);
  index.setFolder("work", { kind: "label", name: "Work" }, [{ key: 2, id: "b@x", size: 200, date: 6 }]);
  index.setFolder("star", { kind: "label", name: "Starred" }, [{ key: 5, id: "b@x", size: 200, date: 6 }]);
  return index;
}

test("resolves a unique real folder and its labels", () => {
  const result = sampleIndex().resolve({ id: "b@x", size: 200, date: 6 });
  assert.equal(result.status, "unique");
  assert.equal(result.location, "Finanzen");
  assert.deepEqual(result.labels, ["Starred", "Work"]);
  assert.deepEqual(
    result.matches.map(m => [m.uri, m.key]),
    [["fin", 7]]
  );
});

test("uses size and date to separate messages sharing a Message-ID", () => {
  const index = sampleIndex();
  const result = index.resolve({ id: "self@x", size: 310, date: 7 });
  assert.equal(result.status, "unique");
  assert.equal(result.location, "Inbox2");
});

test("reports ambiguity when size and date do not separate the copies", () => {
  const result = sampleIndex().resolve({ id: "twin@x", size: 400, date: 8 });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.location, "Sent, Inbox2");
});

test("treats copies with another size or date as different messages", () => {
  const index = sampleIndex();
  assert.equal(index.resolve({ id: "self@x", size: 1, date: 1 }).status, "missing");
  // A single candidate is not enough: it must match size and date too.
  assert.equal(index.resolve({ id: "a@x", size: 101, date: 5 }).status, "missing");
  assert.equal(index.resolve({ id: "a@x", size: 100, date: 6 }).status, "missing");
  assert.deepEqual(index.resolve({ id: "b@x", size: 200, date: 7 }).labels, []);
});

test("explains why a message has no match", () => {
  const index = sampleIndex();
  index.setFolder("lbl", { kind: "label", name: "L" }, [{ key: 1, id: "labelonly@x", size: 1, date: 1 }]);
  const reason = msg => index.resolve(msg).reason;
  assert.equal(reason({ id: "nope@x", size: 1, date: 1 }), "no-copy");
  assert.equal(reason({ id: "labelonly@x", size: 1, date: 1 }), "label-only");
  assert.equal(reason({ id: "a@x", size: 99, date: 5 }), "size");
  assert.equal(reason({ id: "a@x", size: 100, date: 9 }), "date");
  assert.equal(reason({ id: "a@x", size: 99, date: 9 }), "size-date");
  assert.equal(reason({ id: "a@x", size: 100, date: 5 }), "");
  assert.deepEqual(
    index.resolve({ id: "a@x", size: 99, date: 5 }).candidates.map(c => c.uri),
    ["inbox"]
  );
});

test("reports missing messages", () => {
  const result = sampleIndex().resolve({ id: "nope@x", size: 1, date: 1 });
  assert.equal(result.status, "missing");
  assert.equal(result.location, "");
  assert.deepEqual(result.labels, []);
});

test("tracks additions, removals, key changes and folder rescans", () => {
  const index = sampleIndex();
  index.removeEntry("fin", 7);
  assert.equal(index.resolve({ id: "b@x", size: 200, date: 6 }).status, "missing");

  index.addEntry("inbox", { key: 8, id: "b@x", size: 200, date: 6 });
  assert.equal(index.resolve({ id: "b@x", size: 200, date: 6 }).location, "Inbox");

  index.changeKey("inbox", 8, 80);
  assert.equal(index.resolve({ id: "b@x", size: 200, date: 6 }).matches[0].key, 80);

  index.setFolder("inbox", { kind: "real", name: "Inbox" }, []);
  assert.equal(index.resolve({ id: "a@x", size: 100, date: 5 }).status, "missing");
  assert.equal(index.byId.has("a@x"), false);

  index.removeFolder("work");
  assert.deepEqual(index.resolve({ id: "b@x", size: 200, date: 6 }).labels, ["Starred"]);
});

test("ignores entries for unknown folders and messages without Message-ID", () => {
  const index = new LocationIndex();
  index.addEntry("ghost", { key: 1, id: "a@x", size: 1, date: 1 });
  index.setFolder("f", { kind: "real", name: "F" }, [{ key: 1, id: "", size: 1, date: 1 }]);
  assert.deepEqual(index.stats(), { folders: 1, messages: 0 });
});

test("re-adding the same key replaces the entry", () => {
  const index = new LocationIndex();
  index.setFolder("f", { kind: "real", name: "F" }, [{ key: 1, id: "a@x", size: 1, date: 1 }]);
  index.addEntry("f", { key: 1, id: "b@x", size: 1, date: 1 });
  assert.equal(index.resolve({ id: "a@x", size: 1, date: 1 }).status, "missing");
  assert.equal(index.resolve({ id: "b@x", size: 1, date: 1 }).status, "unique");
  assert.deepEqual(index.stats(), { folders: 1, messages: 1 });
});
