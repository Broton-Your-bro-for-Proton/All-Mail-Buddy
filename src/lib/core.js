/* Pure logic shared by the experiment and the unit tests. No Thunderbird APIs here. */
"use strict";

var AllMailCore = (() => {
  const ALL_MAIL = "All Mail";
  const FOLDERS = "Folders";
  const LABELS = "Labels";
  const STARRED = "Starred";
  // Thunderbird stores some copies of the same Bridge message 2 bytes shorter
  // (seen 2994 times on a real account), so sizes may differ by this much.
  const SIZE_TOLERANCE = 2;

  const sameSize = (a, b) => Math.abs(a - b) <= SIZE_TOLERANCE;

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
     * @returns {{status: "unique"|"ambiguous"|"missing"|"nofolder", matches: object[],
     *   location: string, labels: string[], reason: string, candidates: object[]}}
     *   "nofolder" means no real folder has the Message-ID at all: Proton keeps
     *   such a message only in All Mail. reason (missing and nofolder): "no-copy",
     *   "label-only", "size", "date" or "size-date"; candidates are the real
     *   copies with the same Message-ID.
     */
    resolve({ id, size, date }) {
      const refs = [...(this.byId.get(id) ?? [])];
      // Bridge serves the same literal everywhere, so a real copy has the same
      // date and (almost) the same size. A copy that differs is another message.
      const narrow = list => list.filter(r => sameSize(r.size, size) && r.date == date);
      const ofKind = kind => refs.filter(r => this.folders.get(r.uri).kind == kind);
      const candidates = ofKind("real");
      const matches = narrow(candidates);
      const names = list => [...new Set(list.map(r => this.folders.get(r.uri).name))];
      let reason = "";
      if (!matches.length) {
        if (!candidates.length) {
          reason = refs.length ? "label-only" : "no-copy";
        } else {
          const sizeOk = candidates.some(r => sameSize(r.size, size));
          const dateOk = candidates.some(r => r.date == date);
          reason = sizeOk ? "date" : dateOk ? "size" : "size-date";
        }
      }
      return {
        status: candidates.length ? (["missing", "unique"][matches.length] ?? "ambiguous") : "nofolder",
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

  /**
   * Folders whose local copy may be out of date for a resolve result. Proton
   * keeps a message in exactly one folder, so several matching copies, or a
   * copy with another size or date, point to a folder Thunderbird has not
   * synced since the message changed.
   */
  function staleUris(result) {
    const refs = result.status == "ambiguous" ? result.matches : result.candidates;
    return result.status == "unique" ? [] : [...new Set(refs.map(r => r.uri))];
  }

  /**
   * Whether a folder must be synced after an IMAP STATUS check. A changed
   * MESSAGES or UIDNEXT since the last check means something was added, moved
   * or deleted on the server. Without an earlier check, a local message count
   * that differs from the server's means the folder was never fully synced.
   *
   * @param {{previous: ?string, total: number, nextUid: number, localCount: number}} status
   */
  function needsSync({ previous, total, nextUid, localCount }) {
    return previous ? previous != `${total}/${nextUid}` : total != localCount;
  }

  /**
   * What an online search hit says about a folder. Thunderbird only reports
   * hits for UIDs it knows locally, with its local header. A header that is
   * none of the searched messages means the local list maps that UID to
   * another message, so the folder needs a repair ("broken"). A searched
   * message means the folder has it and only the index is behind ("stale").
   *
   * @param {Set<string>} searched - Message-IDs of the search
   * @param {string} hitId - Message-ID of the local header that was hit
   */
  function hitVerdict(searched, hitId) {
    if (searched.has(hitId)) {
      return "stale";
    }
    // IMAP HEADER search matches substrings and ignores case, so a longer ID
    // may contain a searched one.
    const hit = hitId.toLowerCase();
    return [...searched].some(id => hit.includes(id.toLowerCase())) ? "" : "broken";
  }

  /** Server folder paths that Thunderbird does not have. */
  function missingFolders(serverPaths, localPaths) {
    const known = new Set(localPaths);
    return serverPaths.filter(path => !known.has(path)).sort();
  }

  const DAY = 24 * 60 * 60 * 1000;

  /** Whether the daily server check should run now. */
  function serverCheckDue({ enabled, nofolder, last, now }) {
    return !!enabled && nofolder > 0 && now - last >= DAY;
  }

  /** A click on "Repair folders" repairs the same folder at most once a day. */
  function repairedRecently(repairedAt, now) {
    return !!repairedAt && now - repairedAt < DAY;
  }

  /** The daily run repairs a folder at most once a week; a click always may. */
  function mayRepair({ auto, repairedAt, now }) {
    return !auto || !repairedAt || now - repairedAt >= 7 * DAY;
  }

  return {
    mayRepair,
    repairedRecently,
    isBridgeRoot,
    classify,
    LocationIndex,
    staleUris,
    sameSize,
    needsSync,
    hitVerdict,
    missingFolders,
    serverCheckDue,
  };
})();

if (typeof module == "object") {
  module.exports = AllMailCore;
}
