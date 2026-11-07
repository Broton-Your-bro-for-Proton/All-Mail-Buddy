/* Pure logic shared by the experiment and the unit tests. No Thunderbird APIs here. */
"use strict";

var AllMailCore = (() => {
  const ALL_MAIL = "All Mail";
  const FOLDERS = "Folders";
  const LABELS = "Labels";
  const STARRED = "Starred";

  /**
   * True when the child folder names of an account root look like Proton Bridge.
   *
   * @param {string[]} names
   */
  function isBridgeRoot(names) {
    return names.includes(ALL_MAIL) && (names.includes(FOLDERS) || names.includes(LABELS));
  }

  /**
   * Classify a folder by its path below the account root.
   *
   * @param {string[]} names - server names, e.g. ["Folders", "Finanzen"]
   * @param {string[]} [pretty] - display names in the same order
   * @returns {{kind: "allmail"|"real"|"label"|"container", name: string}}
   */
  function classify(names, pretty = names) {
    const [top] = names;
    if (names.length == 1 && top == ALL_MAIL) {
      return { kind: "allmail", name: pretty[0] };
    }
    if (names.length == 1 && (top == FOLDERS || top == LABELS)) {
      return { kind: "container", name: pretty[0] };
    }
    if (names.length == 1 && top == STARRED) {
      return { kind: "label", name: pretty[0] };
    }
    if (top == LABELS) {
      return { kind: "label", name: pretty.slice(1).join("/") };
    }
    if (top == FOLDERS) {
      return { kind: "real", name: pretty.slice(1).join("/") };
    }
    return { kind: "real", name: pretty.join("/") };
  }

  /**
   * Message-ID based index of one account. Entries are {key, id, size, date}.
   */
  class LocationIndex {
    constructor() {
      this.folders = new Map(); // folder uri -> {kind, name, byKey: Map<key, ref>}
      this.byId = new Map(); // message id -> Set<ref>
    }

    hasFolder(uri) {
      return this.folders.has(uri);
    }

    setFolder(uri, info, entries) {
      this.removeFolder(uri);
      this.folders.set(uri, { kind: info.kind, name: info.name, byKey: new Map() });
      for (const entry of entries) {
        this.addEntry(uri, entry);
      }
    }

    removeFolder(uri) {
      const folder = this.folders.get(uri);
      if (!folder) {
        return;
      }
      for (const key of [...folder.byKey.keys()]) {
        this.removeEntry(uri, key);
      }
      this.folders.delete(uri);
    }

    addEntry(uri, { key, id, size, date }) {
      const folder = this.folders.get(uri);
      if (!folder || !id) {
        return;
      }
      this.removeEntry(uri, key);
      const ref = { uri, key, id, size, date };
      folder.byKey.set(key, ref);
      let set = this.byId.get(id);
      if (!set) {
        set = new Set();
        this.byId.set(id, set);
      }
      set.add(ref);
    }

    removeEntry(uri, key) {
      const ref = this.folders.get(uri)?.byKey.get(key);
      if (!ref) {
        return;
      }
      this.folders.get(uri).byKey.delete(key);
      const set = this.byId.get(ref.id);
      set.delete(ref);
      if (!set.size) {
        this.byId.delete(ref.id);
      }
    }

    changeKey(uri, oldKey, newKey) {
      const ref = this.folders.get(uri)?.byKey.get(oldKey);
      if (ref) {
        this.removeEntry(uri, oldKey);
        this.addEntry(uri, { ...ref, key: newKey });
      }
    }

    /**
     * Find the real folder and the labels of a message.
     *
     * @param {{id: string, size: number, date: number}} msg
     * @returns {{status: "unique"|"ambiguous"|"missing", matches: object[],
     *   location: string, labels: string[], reason: string, candidates: object[]}}
     *   reason (only when missing): "no-copy", "label-only", "size", "date" or
     *   "size-date"; candidates are the real copies with the same Message-ID.
     */
    resolve({ id, size, date }) {
      const refs = [...(this.byId.get(id) ?? [])];
      // Bridge serves the same literal everywhere, so a real copy always has the
      // same size and date. A copy that differs is another message.
      const narrow = list => list.filter(r => r.size == size && r.date == date);
      const ofKind = kind => refs.filter(r => this.folders.get(r.uri).kind == kind);
      const candidates = ofKind("real");
      const matches = narrow(candidates);
      const names = list => [...new Set(list.map(r => this.folders.get(r.uri).name))];
      let reason = "";
      if (!matches.length) {
        if (!candidates.length) {
          reason = refs.length ? "label-only" : "no-copy";
        } else {
          const sizeOk = candidates.some(r => r.size == size);
          const dateOk = candidates.some(r => r.date == date);
          reason = sizeOk ? "date" : dateOk ? "size" : "size-date";
        }
      }
      return {
        status: ["missing", "unique"][matches.length] ?? "ambiguous",
        matches,
        location: names(matches).join(", "),
        labels: names(narrow(ofKind("label"))).sort(),
        reason,
        candidates,
      };
    }

    stats() {
      let messages = 0;
      for (const folder of this.folders.values()) {
        messages += folder.byKey.size;
      }
      return { folders: this.folders.size, messages };
    }
  }

  return { isBridgeRoot, classify, LocationIndex };
})();

if (typeof module == "object") {
  module.exports = AllMailCore;
}
