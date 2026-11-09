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
  assert.equal(index.resolve({ id: "a@x", size: 200, date: 5 }).status, "missing");
  assert.equal(index.resolve({ id: "a@x", size: 100, date: 6 }).status, "missing");
  assert.deepEqual(index.resolve({ id: "b@x", size: 200, date: 7 }).labels, []);
});

test("explains why a message has no match", () => {
  const index = sampleIndex();
  index.setFolder("lbl", { kind: "label", name: "L" }, [{ key: 1, id: "labelonly@x", size: 1, date: 1 }]);
  const reason = msg => index.resolve(msg).reason;
  assert.equal(reason({ id: "nope@x", size: 1, date: 1 }), "no-copy");
  assert.equal(reason({ id: "labelonly@x", size: 1, date: 1 }), "label-only");
  assert.equal(reason({ id: "a@x", size: 40, date: 5 }), "size");
  assert.equal(reason({ id: "a@x", size: 100, date: 9 }), "date");
  assert.equal(reason({ id: "a@x", size: 40, date: 9 }), "size-date");
  assert.equal(reason({ id: "a@x", size: 100, date: 5 }), "");
  assert.deepEqual(
    index.resolve({ id: "a@x", size: 40, date: 5 }).candidates.map(c => c.uri),
    ["inbox"]
  );
});

test("names folders that may be out of date", () => {
  const index = sampleIndex();
  const { staleUris } = require("../src/lib/core.js");
  assert.deepEqual(staleUris(index.resolve({ id: "b@x", size: 200, date: 6 })), []);
  assert.deepEqual(staleUris(index.resolve({ id: "twin@x", size: 400, date: 8 })).sort(), ["inbox2", "sent"]);
  assert.deepEqual(staleUris(index.resolve({ id: "a@x", size: 40, date: 5 })), ["inbox"]);
  assert.deepEqual(staleUris(index.resolve({ id: "nope@x", size: 1, date: 1 })), []);
});

test("tolerates the 2 byte size difference Thunderbird introduces", () => {
  const index = sampleIndex();
  assert.equal(index.resolve({ id: "a@x", size: 102, date: 5 }).status, "unique");
  assert.equal(index.resolve({ id: "a@x", size: 98, date: 5 }).status, "unique");
  assert.equal(index.resolve({ id: "a@x", size: 102, date: 5 }).near, false);
  // Beyond 2 bytes it only counts as a close copy.
  assert.equal(index.resolve({ id: "a@x", size: 103, date: 5 }).near, true);
});

test("without an exact copy, a copy a few bytes off with the same date is the message", () => {
  const index = sampleIndex();
  const near = index.resolve({ id: "a@x", size: 117, date: 5 });
  assert.equal(near.status, "unique");
  assert.equal(near.near, true);
  assert.equal(near.location, "Inbox");
  assert.equal(index.resolve({ id: "a@x", size: 100, date: 5 }).near, false);
  // More than 32 bytes, or another date, stays a different message.
  assert.equal(index.resolve({ id: "a@x", size: 140, date: 5 }).status, "missing");
  assert.equal(index.resolve({ id: "a@x", size: 110, date: 6 }).status, "missing");
  // An exact copy wins over a close one.
  index.setFolder("other", { kind: "real", name: "Other" }, [{ key: 1, id: "a@x", size: 110, date: 5 }]);
  assert.equal(index.resolve({ id: "a@x", size: 110, date: 5 }).location, "Other");
});

test("orders copies stably for pairing", () => {
  const { sortedMatches, twinKey } = require("../src/lib/core.js");
  const index = new LocationIndex();
  index.setFolder("paypal", { kind: "real", name: "Paypal" }, [
    { key: 4, id: "dup@x", size: 10, date: 1 },
    { key: 9, id: "dup@x", size: 10, date: 1 },
  ]);
  index.setFolder("sent", { kind: "real", name: "Sent" }, [{ key: 2, id: "self@x", size: 5, date: 1 }]);
  index.setFolder("inbox", { kind: "real", name: "Inbox" }, [{ key: 3, id: "self@x", size: 5, date: 1 }]);
  const dup = index.resolve({ id: "dup@x", size: 10, date: 1 });
  assert.equal(dup.status, "ambiguous");
  assert.equal(dup.location, "Paypal");
  assert.deepEqual(sortedMatches(dup).map(m => m.key), [4, 9]);
  assert.deepEqual(
    sortedMatches(index.resolve({ id: "self@x", size: 5, date: 1 })).map(m => m.uri),
    ["inbox", "sent"]
  );
  assert.equal(twinKey({ id: "dup@x", date: 1 }), twinKey({ id: "dup@x", date: 1, size: 99 }));
  assert.notEqual(twinKey({ id: "dup@x", date: 1 }), twinKey({ id: "dup@x", date: 2 }));
});

test("decides which folders need a sync after STATUS", () => {
  const { needsSync } = require("../src/lib/core.js");
  assert.equal(needsSync({ previous: null, total: 5, nextUid: 9, localCount: 5 }), false);
  assert.equal(needsSync({ previous: null, total: 6, nextUid: 9, localCount: 5 }), true);
  assert.equal(needsSync({ previous: "5/9", total: 5, nextUid: 9, localCount: 1 }), false);
  assert.equal(needsSync({ previous: "5/9", total: 5, nextUid: 10, localCount: 5 }), true);
  assert.equal(needsSync({ previous: "5/9", total: 4, nextUid: 9, localCount: 5 }), true);
});

test("reports messages that have no real folder at all", () => {
  const index = sampleIndex();
  const result = index.resolve({ id: "nope@x", size: 1, date: 1 });
  assert.equal(result.status, "nofolder");
  assert.equal(result.location, "");
  assert.deepEqual(result.labels, []);
  index.setFolder("lbl", { kind: "label", name: "L" }, [{ key: 1, id: "labelonly@x", size: 1, date: 1 }]);
  const labelOnly = index.resolve({ id: "labelonly@x", size: 1, date: 1 });
  assert.equal(labelOnly.status, "nofolder");
  assert.deepEqual(labelOnly.labels, ["L"]);
  // A real copy that differs is a stale folder, not a missing folder.
  assert.equal(index.resolve({ id: "a@x", size: 50, date: 5 }).status, "missing");
});

test("tracks additions, removals, key changes and folder rescans", () => {
  const index = sampleIndex();
  index.removeEntry("fin", 7);
  assert.equal(index.resolve({ id: "b@x", size: 200, date: 6 }).status, "nofolder");

  index.addEntry("inbox", { key: 8, id: "b@x", size: 200, date: 6 });
  assert.equal(index.resolve({ id: "b@x", size: 200, date: 6 }).location, "Inbox");

  index.changeKey("inbox", 8, 80);
  assert.equal(index.resolve({ id: "b@x", size: 200, date: 6 }).matches[0].key, 80);

  index.setFolder("inbox", { kind: "real", name: "Inbox" }, []);
  assert.equal(index.resolve({ id: "a@x", size: 100, date: 5 }).status, "nofolder");
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
  assert.equal(index.resolve({ id: "a@x", size: 1, date: 1 }).status, "nofolder");
  assert.equal(index.resolve({ id: "b@x", size: 1, date: 1 }).status, "unique");
  assert.deepEqual(index.stats(), { folders: 1, messages: 1 });
});

test("judges online search hits", () => {
  const { hitVerdict } = require("../src/lib/core.js");
  const searched = new Set(["a@x", "b@x"]);
  assert.equal(hitVerdict(searched, "a@x"), "stale");
  assert.equal(hitVerdict(searched, "other@y"), "broken");
  // HEADER search matches substrings; a longer ID is not proof of a broken list.
  assert.equal(hitVerdict(searched, "1a@x"), "");
  // IMAP SEARCH ignores case.
  assert.equal(hitVerdict(searched, "1A@X"), "");
});

test("a click repairs the same folder at most once a day", () => {
  const { repairedRecently } = require("../src/lib/core.js");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(repairedRecently(undefined, 10 * day), false);
  assert.equal(repairedRecently(10 * day - 1000, 10 * day), true);
  assert.equal(repairedRecently(9 * day, 10 * day), false);
});

test("a folder whose copies still differ after a repair is left alone for 30 days", () => {
  const { knownUnfixable } = require("../src/lib/core.js");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(knownUnfixable(undefined, 100 * day), false);
  assert.equal(knownUnfixable(80 * day, 100 * day), true);
  assert.equal(knownUnfixable(70 * day, 100 * day), false);
});

test("the daily run repairs a folder at most once a week", () => {
  const { mayRepair } = require("../src/lib/core.js");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(mayRepair({ auto: true, repairedAt: undefined, now: 10 * day }), true);
  assert.equal(mayRepair({ auto: true, repairedAt: 5 * day, now: 10 * day }), false);
  assert.equal(mayRepair({ auto: true, repairedAt: 3 * day, now: 10 * day }), true);
  assert.equal(mayRepair({ auto: false, repairedAt: 9 * day, now: 10 * day }), true);
});

test("lists server folders that Thunderbird does not have", () => {
  const { missingFolders } = require("../src/lib/core.js");
  assert.deepEqual(
    missingFolders(["INBOX", "Folders/B", "Folders/A", "Labels/X"], ["INBOX", "Labels/X"]),
    ["Folders/A", "Folders/B"]
  );
  assert.deepEqual(missingFolders(["INBOX"], ["INBOX", "Extra"]), []);
});

test("runs the server check at most daily and only when needed", () => {
  const { serverCheckDue } = require("../src/lib/core.js");
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  assert.equal(serverCheckDue({ enabled: true, nofolder: 5, last: 0, now }), true);
  assert.equal(serverCheckDue({ enabled: true, nofolder: 5, last: now - day + 1, now }), false);
  assert.equal(serverCheckDue({ enabled: true, nofolder: 0, last: 0, now }), false);
  assert.equal(serverCheckDue({ enabled: false, nofolder: 5, last: 0, now }), false);
});
