/* Experiment API: location index, thread pane columns and All Mail action routing. */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
var { MessageArchiver } = ChromeUtils.importESModule("resource:///modules/MessageArchiver.sys.mjs");
var { ThreadPaneColumns } = ChromeUtils.importESModule("chrome://messenger/content/ThreadPaneColumns.mjs");
var { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const LOCATION_COLUMN = "allMailPlusLocation";
const LABELS_COLUMN = "allMailPlusLabels";
const INIT_PROPERTY = "allMailPlusColumnsInit";

const HANDLED_COMMANDS = new Set([
  "cmd_deleteMessage",
  "cmd_shiftDeleteMessage",
  "cmd_moveMessage",
  "cmd_copyMessage",
  "cmd_archive",
  "cmd_markAsJunk",
  "cmd_markAsNotJunk",
]);
// Commands that about:message inside about:3pane hands to its parent window.
const FORWARDED_COMMANDS = new Set([
  "cmd_deleteMessage",
  "cmd_shiftDeleteMessage",
  "cmd_moveMessage",
  "cmd_archive",
]);

const RESOURCE_HOST = "allmailplus";
const STATUS_TOPIC = "allmailplus-status";
const CHECK_SECONDS = 60;
const resourceHandler = () =>
  Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsISubstitutingProtocolHandler);

const Flags = Ci.nsMsgFolderFlags;
const mfn = Ci.nsIMsgFolderNotificationService;

let core = null;
const emitter = new ExtensionCommon.EventEmitter();

const controller = {
  started: false,
  config: { syncOnStartup: true, syncIntervalMinutes: 15, disabledAccounts: [] },
  accounts: new Map(), // server key -> account state
  unhooks: new Set(),
  timers: new Map(),
  scanning: new Set(), // folder uris whose snapshot is being taken
  dirty: new Set(), // folder uris that changed during their snapshot
  pendingSync: false,
  refreshedAt: new Map(), // folder uri -> time of the last targeted sync
  syncTimer: null,
  checkTimer: null,
  statusSeen: new Map(), // folder uri -> "MESSAGES/UIDNEXT" from the last STATUS check
  lastNotice: "",

  // ---- lifecycle -------------------------------------------------------

  start(extension, config) {
    if (this.started) {
      return this.configure(config);
    }
    this.started = true;
    const scope = {};
    resourceHandler().setSubstitution(RESOURCE_HOST, extension.rootURI);
    Services.scriptloader.loadSubScriptWithOptions(`resource://${RESOURCE_HOST}/lib/core.js`, {
      target: scope,
      ignoreCache: true,
    });
    core = scope.AllMailCore;
    this.config = { ...this.config, ...config };

    this.registerColumns();
    MailServices.mfn.addListener(
      this.folderListener,
      mfn.msgAdded | mfn.msgsDeleted | mfn.msgsMoveCopyCompleted | mfn.msgKeyChanged |
        mfn.folderAdded | mfn.folderDeleted | mfn.folderMoveCopyCompleted | mfn.folderRenamed
    );
    MailServices.mailSession.AddFolderListener(this.loadListener, Ci.nsIFolderListener.event);
    Services.obs.addObserver(this, "chrome-document-global-created");
    Services.obs.addObserver(this, STATUS_TOPIC);
    this.hookExistingWindows();
    this.rebuild(this.config.syncOnStartup);
    this.scheduleSync();
    this.scheduleCheck();
    return this.status();
  },

  stop() {
    if (!this.started) {
      return;
    }
    this.started = false;
    MailServices.mfn.removeListener(this.folderListener);
    MailServices.mailSession.RemoveFolderListener(this.loadListener);
    Services.obs.removeObserver(this, "chrome-document-global-created");
    Services.obs.removeObserver(this, STATUS_TOPIC);
    for (const unhook of this.unhooks) {
      unhook();
    }
    this.unhooks.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.scanning.clear();
    this.dirty.clear();
    this.refreshedAt.clear();
    clearTimeout(this.syncTimer);
    clearTimeout(this.checkTimer);
    this.statusSeen.clear();
    resourceHandler().setSubstitution(RESOURCE_HOST, null);
    ThreadPaneColumns.removeCustomColumn(LOCATION_COLUMN);
    ThreadPaneColumns.removeCustomColumn(LABELS_COLUMN);
    this.accounts.clear();
  },

  configure(config) {
    const before = JSON.stringify(this.config.disabledAccounts);
    this.config = { ...this.config, ...config };
    if (JSON.stringify(this.config.disabledAccounts) != before) {
      this.rebuild(false);
    }
    this.scheduleSync();
    return this.status();
  },

  failed(error) {
    console.error("All Mail+:", error);
    this.notice(`The action failed: ${error.message}. Some messages may already have been changed.`);
  },

  notice(text) {
    Services.console.logStringMessage(`All Mail+: ${text}`);
    this.lastNotice = text;
    emitter.emit("notice", text);
  },

  debounce(name, ms, fn) {
    clearTimeout(this.timers.get(name));
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        fn();
      }, ms)
    );
  },

  // ---- accounts and folders ---------------------------------------------

  detectAccounts() {
    const found = [];
    for (const account of MailServices.accounts.accounts) {
      const server = account.incomingServer;
      if (!server || server.type == "rss" || server.type == "nntp") {
        continue;
      }
      const root = server.rootFolder;
      if (!core.isBridgeRoot(root.subFolders.map(f => f.name))) {
        continue;
      }
      found.push({ server, root, enabled: !this.config.disabledAccounts.includes(server.key) });
    }
    return found;
  },

  describe(folder) {
    const names = [];
    const pretty = [];
    for (let f = folder; f && !f.isServer; f = f.parent) {
      names.unshift(f.name);
      pretty.unshift(f.localizedName);
    }
    return core.classify(names, pretty);
  },

  accountFor(folder) {
    return folder && this.accounts.get(folder.server?.key);
  },

  isAllMail(folder) {
    return !!folder && this.accountFor(folder)?.allMailURI == folder.URI;
  },

  async rebuild(sync) {
    const generation = (this.generation = (this.generation ?? 0) + 1);
    // A newer rebuild supersedes this one, so it has to carry the sync request.
    this.pendingSync ||= sync;
    const previous = new Map(this.accounts);
    this.accounts.clear();
    for (const { server, root, enabled } of this.detectAccounts()) {
      if (!enabled) {
        continue;
      }
      const allMail = root.subFolders.find(f => f.name == "All Mail");
      this.accounts.set(server.key, {
        key: server.key,
        name: server.prettyName,
        server,
        root,
        allMail,
        allMailURI: allMail.URI,
        index: new core.LocationIndex(),
        state: "indexing",
        lastSync: previous.get(server.key)?.lastSync ?? null,
        coverage: null,
        unreadable: new Set(),
        error: "",
      });
      this.initColumnState(allMail);
    }
    for (const account of this.accounts.values()) {
      try {
        for (const folder of this.trackedFolders(account)) {
          if (generation != this.generation) {
            return;
          }
          await this.scanFolder(account, folder);
        }
        if (generation != this.generation) {
          return;
        }
        account.state = "ready";
        this.coverageLater(account);
      } catch (e) {
        account.state = "error";
        account.error = String(e);
        console.error(e);
      }
    }
    this.refreshColumns();
    if (this.pendingSync) {
      this.pendingSync = false;
      await this.syncAll();
    }
  },

  trackedFolders(account) {
    return account.root.descendants.filter(folder => {
      if (folder.flags & Flags.Virtual) {
        return false;
      }
      const { kind } = this.describe(folder);
      return kind == "real" || kind == "label";
    });
  },

  async scanFolder(account, folder) {
    const info = this.describe(folder);
    const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIMsgDBService);
    const wasOpen = !!dbService.cachedDBForFolder(folder);
    let db;
    try {
      db = folder.msgDatabase;
    } catch {
      account.index.setFolder(folder.URI, info, []);
      account.unreadable.add(info.name);
      return;
    }
    account.unreadable.delete(info.name);
    const keys = db.listAllKeys();
    this.scanning.add(folder.URI);
    const entries = [];
    for (let i = 0; i < keys.length; i++) {
      if (i % 2000 == 1999) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      let hdr;
      try {
        hdr = db.getMsgHdrForKey(keys[i]);
      } catch {
        continue;
      }
      if (!(hdr.flags & Ci.nsMsgMessageFlags.IMAPDeleted)) {
        entries.push(this.entryOf(hdr));
      }
    }
    account.index.setFolder(folder.URI, info, entries);
    this.scanning.delete(folder.URI);
    if (this.dirty.delete(folder.URI)) {
      // Changes arrived while the snapshot was taken and were overwritten.
      this.rescanLater(folder);
    }
    if (!wasOpen) {
      try {
        folder.closeDBIfFolderNotOpen(false);
      } catch {}
    }
  },

  entryOf(hdr) {
    return { key: hdr.messageKey, id: hdr.messageId, size: hdr.messageSize, date: hdr.date };
  },

  rescanLater(folder) {
    const account = this.accountFor(folder);
    if (!account || !account.index.hasFolder(folder.URI)) {
      return;
    }
    this.debounce(`scan:${folder.URI}`, 500, async () => {
      await this.scanFolder(account, folder);
      this.coverageLater(account);
      this.refreshColumns();
    });
  },

  coverageLater(account) {
    this.debounce(`coverage:${account.key}`, 2000, () => this.updateCoverage(account));
  },

  /**
   * Counts how All Mail resolves. For messages without a match it records why,
   * and how far size (bytes) and date (seconds) are off from the closest copy.
   */
  async updateCoverage(account) {
    const coverage = {
      unique: 0,
      ambiguous: 0,
      missing: 0,
      reasons: {},
      sizeDeltas: {},
      dateDeltas: {},
      examples: [], // a few messages without any real copy, to look them up in Proton
    };
    const count = (map, key) => (map[key] = (map[key] ?? 0) + 1);
    const stale = new Set();
    try {
      const db = account.allMail.msgDatabase;
      const keys = db.listAllKeys();
      for (let i = 0; i < keys.length; i++) {
        if (i % 2000 == 1999) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const hdr = db.getMsgHdrForKey(keys[i]);
        const entry = this.entryOf(hdr);
        const result = account.index.resolve(entry);
        coverage[result.status]++;
        core.staleUris(result).forEach(uri => stale.add(uri));
        if (result.reason) {
          count(coverage.reasons, result.reason);
          if (result.reason == "no-copy" && coverage.examples.length < 5) {
            coverage.examples.push({ subject: hdr.mime2DecodedSubject, date: hdr.date / 1000 });
          }
          const [closest] = result.candidates;
          if (closest && closest.size != entry.size) {
            count(coverage.sizeDeltas, closest.size - entry.size);
          }
          if (closest && closest.date != entry.date) {
            count(coverage.dateDeltas, Math.round((closest.date - entry.date) / 1e6));
          }
        }
      }
    } catch {}
    account.coverage = coverage;
    this.refreshFolders(account, stale, 10 * 60000).catch(console.error);
  },

  /**
   * Syncs folders that look out of date and rescans them. Each folder is synced
   * at most once per minAge, which also stops coverage and refresh from looping.
   */
  async refreshFolders(account, uris, minAge) {
    if (account.server.type != "imap") {
      return;
    }
    const now = Date.now();
    const due = [...uris].filter(uri => now - (this.refreshedAt.get(uri) ?? 0) > minAge).slice(0, 25);
    for (const uri of due) {
      this.refreshedAt.set(uri, now);
      const folder = MailServices.folderLookup.getFolderForURL(uri);
      if (folder && account.index.hasFolder(uri)) {
        await this.updateFolder(folder);
        await this.scanFolder(account, folder);
      }
    }
    if (due.length) {
      this.coverageLater(account);
      this.refreshColumns();
    }
  },

  // ---- change detection ------------------------------------------------------

  /**
   * Thunderbird only syncs an IMAP folder when it is opened, so changes made in
   * other Proton clients leave its local list stale. A cheap STATUS per folder
   * shows which folders changed on the server; only those are synced.
   */
  scheduleCheck() {
    clearTimeout(this.checkTimer);
    if (this.started) {
      this.checkTimer = setTimeout(async () => {
        try {
          for (const account of [...this.accounts.values()]) {
            await this.checkChanges(account);
          }
        } catch (e) {
          console.error("All Mail+:", e);
        } finally {
          this.scheduleCheck();
        }
      }, CHECK_SECONDS * 1000);
    }
  },

  async checkChanges(account) {
    if (account.server.type != "imap" || account.state != "ready" || account.checking) {
      return;
    }
    account.checking = true;
    try {
      await this.syncChangedFolders(account);
    } finally {
      account.checking = false;
    }
  },

  async syncChangedFolders(account) {
    const changed = [];
    for (const folder of [...this.trackedFolders(account), account.allMail]) {
      const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
      await this.urlDone(listener => imap.updateStatus(listener, null), 15000);
      const status = { total: imap.serverTotal, nextUid: imap.serverNextUID };
      const seen = `${status.total}/${status.nextUid}`;
      const previous = this.statusSeen.get(folder.URI) ?? null;
      this.statusSeen.set(folder.URI, seen);
      if (core.needsSync({ previous, ...status, localCount: folder.getTotalMessages(false) })) {
        changed.push(folder);
      }
    }
    for (const folder of changed) {
      await this.updateFolder(folder);
      if (folder != account.allMail) {
        await this.scanFolder(account, folder);
        this.refreshedAt.set(folder.URI, Date.now());
      }
    }
    if (changed.length) {
      this.coverageLater(account);
      this.refreshColumns();
    }
  },

  // ---- syncing -------------------------------------------------------------

  scheduleSync() {
    clearTimeout(this.syncTimer);
    const minutes = Number(this.config.syncIntervalMinutes);
    if (this.started && minutes > 0) {
      this.syncTimer = setTimeout(async () => {
        try {
          await this.syncAll();
        } finally {
          this.scheduleSync();
        }
      }, minutes * 60000);
    }
  },

  async syncAll() {
    for (const account of [...this.accounts.values()]) {
      if (account.state != "ready") {
        continue;
      }
      account.state = "syncing";
      try {
        const folders = [...this.trackedFolders(account), account.allMail];
        for (const folder of folders) {
          if (account.server.type == "imap") {
            await this.updateFolder(folder);
          }
          if (folder != account.allMail) {
            await this.scanFolder(account, folder);
            this.refreshedAt.set(folder.URI, Date.now());
          }
        }
        account.lastSync = Date.now();
      } catch (e) {
        account.error = String(e);
        console.error(e);
      } finally {
        account.state = "ready";
        this.coverageLater(account);
      }
    }
    this.refreshColumns();
    return this.status();
  },

  updateFolder(folder) {
    return this.urlDone(listener => folder.updateFolderWithListener(null, listener), 60000);
  },

  /** Runs an IMAP operation that reports through an nsIUrlListener, with a timeout. */
  urlDone(start, timeout) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, timeout);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        start({
          QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
          OnStartRunningUrl() {},
          OnStopRunningUrl: done,
        });
      } catch {
        done();
      }
    });
  },

  // ---- folder listeners ----------------------------------------------------

  folderListener: {
    QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
    msgAdded(hdr) {
      controller.indexAdd([hdr]);
    },
    msgsDeleted(hdrs) {
      controller.indexRemove(hdrs);
    },
    msgsMoveCopyCompleted(isMove, srcHdrs, destFolder, destHdrs) {
      if (isMove) {
        controller.indexRemove(srcHdrs);
      }
      if (destHdrs?.length) {
        controller.indexAdd(destHdrs);
      } else {
        controller.rescanLater(destFolder);
      }
    },
    msgKeyChanged(oldKey, hdr) {
      controller.accountFor(hdr.folder)?.index.changeKey(hdr.folder.URI, oldKey, hdr.messageKey);
    },
    folderAdded(folder) {
      controller.rebuildLater(folder);
    },
    folderDeleted(folder) {
      controller.rebuildLater(folder);
    },
    folderMoveCopyCompleted(isMove, src) {
      controller.rebuildLater(src);
    },
    folderRenamed(oldFolder, newFolder) {
      controller.rebuildLater(newFolder);
    },
  },

  loadListener: {
    QueryInterface: ChromeUtils.generateQI(["nsIFolderListener"]),
    onFolderEvent(folder, event) {
      if (event != "FolderLoaded") {
        return;
      }
      if (controller.isAllMail(folder)) {
        const account = controller.accountFor(folder);
        controller.coverageLater(account);
        // Opening All Mail is a good moment to look for changes made elsewhere.
        controller.debounce(`check:${account.key}`, 2000, () => controller.checkChanges(account).catch(console.error));
        controller.refreshColumns();
      } else {
        controller.rescanLater(folder);
      }
    },
  },

  markDirty(hdrs) {
    for (const hdr of hdrs) {
      if (this.scanning.has(hdr.folder.URI)) {
        this.dirty.add(hdr.folder.URI);
      }
    }
  },

  indexAdd(hdrs) {
    this.markDirty(hdrs);
    for (const hdr of hdrs) {
      const account = this.accountFor(hdr.folder);
      if (account?.index.hasFolder(hdr.folder.URI)) {
        account.index.addEntry(hdr.folder.URI, this.entryOf(hdr));
      }
    }
    this.refreshColumns();
  },

  indexRemove(hdrs) {
    this.markDirty(hdrs);
    for (const hdr of hdrs) {
      this.accountFor(hdr.folder)?.index.removeEntry(hdr.folder.URI, hdr.messageKey);
    }
    this.refreshColumns();
  },

  rebuildLater(folder) {
    if (this.accountFor(folder) || this.detectAccounts().some(a => a.server == folder?.server)) {
      this.debounce("rebuild", 1000, () => this.rebuild(false));
    }
  },

  // ---- columns -------------------------------------------------------------

  /** Real folder of a message shown in All Mail or a label folder, else "". */
  locationText(hdr) {
    const account = this.accountFor(hdr.folder);
    const kind = account && this.describe(hdr.folder).kind;
    if (kind != "allmail" && kind != "label") {
      return "";
    }
    const result = account.index.resolve(this.entryOf(hdr));
    if (result.status == "missing") {
      return account.state == "ready" ? "?" : "…";
    }
    return result.location;
  },

  labelsText(hdr) {
    const account = this.accountFor(hdr.folder);
    return account ? account.index.resolve(this.entryOf(hdr)).labels.join(", ") : "";
  },

  registerColumns() {
    const names = this.config.columnNames ?? {};
    ThreadPaneColumns.addCustomColumn(LOCATION_COLUMN, {
      name: names.folder || "Folder",
      hidden: true,
      sortable: true,
      textCallback: hdr => this.locationText(hdr),
    });
    ThreadPaneColumns.addCustomColumn(LABELS_COLUMN, {
      name: names.labels || "Labels",
      hidden: true,
      sortable: true,
      textCallback: hdr => this.labelsText(hdr),
    });
  },

  /** Cards view has no columns, so the location goes into a badge on the card. */
  decorateCard(win, card) {
    let text = "";
    try {
      const hdr = win.gDBView.getMsgHdrAt(card._index);
      text = [this.locationText(hdr), this.labelsText(hdr)].filter(Boolean).join(" · ");
    } catch {}
    let badge = card.querySelector(".allmailplus-badge");
    if (!text) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = card.ownerDocument.createElement("span");
      badge.className = "allmailplus-badge";
      badge.style.cssText =
        "margin-inline-end: 6px; padding: 0 5px; border: 1px solid currentColor; border-radius: 3px;" +
        "color: light-dark(#78643e, #b49a64); font-size: 0.85em; white-space: nowrap; overflow: hidden;" +
        "text-overflow: ellipsis;";
      card.querySelector(".thread-card-dynamic-row")?.prepend(badge);
    }
    badge.textContent = text;
    badge.title = text;
  },

  refreshColumns() {
    this.debounce("refresh", 250, () => ThreadPaneColumns.refreshCustomColumn(LOCATION_COLUMN));
  },

  /** Show both columns in an All Mail folder once, without overriding later choices. */
  initColumnState(folder) {
    try {
      const info = folder.msgDatabase.dBFolderInfo;
      if (info.getCharProperty(INIT_PROPERTY) == "1") {
        return;
      }
      const saved = info.getCharProperty("columnStates");
      const state = saved ? JSON.parse(saved) : {};
      if (!saved) {
        for (const column of ThreadPaneColumns.getDefaultColumns(folder)) {
          state[column.id] = { visible: !column.hidden, ordinal: column.ordinal };
        }
      }
      let ordinal = Math.max(0, ...Object.values(state).map(s => s.ordinal ?? 0));
      for (const id of [LOCATION_COLUMN, LABELS_COLUMN]) {
        state[id] = { visible: true, ordinal: ++ordinal };
      }
      info.setCharProperty("columnStates", JSON.stringify(state));
      info.setCharProperty(INIT_PROPERTY, "1");
    } catch (e) {
      console.warn("All Mail+: could not initialize columns", e);
    }
  },

  // ---- window hooks --------------------------------------------------------

  observe(subject, topic) {
    if (topic == STATUS_TOPIC) {
      // Diagnostics for tests and support: fills an nsISupportsString with the status.
      subject.QueryInterface(Ci.nsISupportsString).data = JSON.stringify(this.status());
      return;
    }
    subject.addEventListener("load", () => this.hookWindow(subject), { once: true });
  },

  hookExistingWindows() {
    for (const top of Services.wm.getEnumerator(null)) {
      for (const context of top.browsingContext.getAllBrowsingContextsInSubtree()) {
        const win = context.window;
        if (win?.document.readyState == "complete") {
          this.hookWindow(win);
        } else if (win) {
          win.addEventListener("load", () => this.hookWindow(win), { once: true });
        }
      }
    }
  },

  hookWindow(win) {
    const href = win.location?.href ?? "";
    const is3Pane = href.startsWith("about:3pane");
    if (
      !this.started ||
      (!is3Pane && !href.startsWith("about:message")) ||
      !win.commandController ||
      win.allMailPlusHooked
    ) {
      return;
    }
    win.allMailPlusHooked = true;
    const commands = win.commandController;
    const nativeDoCommand = commands.doCommand;
    commands.doCommand = function (command, ...args) {
      if (HANDLED_COMMANDS.has(command) && commands.isCommandEnabled(command)) {
        try {
          if (controller.handleCommand(win, command, args)) {
            return undefined;
          }
        } catch (e) {
          controller.failed(e);
          return undefined;
        }
      }
      return nativeDoCommand.call(this, command, ...args);
    };
    const undo = [() => (commands.doCommand = nativeDoCommand)];

    if (is3Pane) {
      const pane = win.folderPane;
      const nativeDrop = pane._onDrop;
      pane._onDrop = function (event) {
        if (controller.handleDrop(win, this, event)) {
          return undefined;
        }
        return nativeDrop.call(this, event);
      };
      undo.push(() => (pane._onDrop = nativeDrop));

      const onRowEvent = event => controller.handleRowEvent(win, event);
      win.addEventListener("request-delete", onRowEvent, true);
      win.addEventListener("toggle-spam", onRowEvent, true);
      undo.push(() => {
        win.removeEventListener("request-delete", onRowEvent, true);
        win.removeEventListener("toggle-spam", onRowEvent, true);
      });

      win.customElements.whenDefined("thread-card").then(() => {
        const Card = win.customElements.get("thread-card");
        if (!win.allMailPlusHooked) {
          return;
        }
        const nativeFill = Card.prototype.fillRow;
        Card.prototype.fillRow = function () {
          nativeFill.call(this);
          controller.decorateCard(win, this);
        };
        undo.push(() => (Card.prototype.fillRow = nativeFill));
      });
    }

    const unhook = () => {
      undo.forEach(fn => fn());
      delete win.allMailPlusHooked;
    };
    this.unhooks.add(unhook);
    win.addEventListener("unload", () => this.unhooks.delete(unhook), { once: true });
  },

  selectedHdrs(win) {
    if (win.location.href.startsWith("about:message")) {
      return win.gMessage ? [win.gMessage] : [];
    }
    return win.gDBView?.getSelectedMsgHdrs() ?? [];
  },

  /** @returns {boolean} true when the command was taken over. */
  handleCommand(win, command, args) {
    if (
      FORWARDED_COMMANDS.has(command) &&
      win.location.href.startsWith("about:message") &&
      win.parent?.location.href.startsWith("about:3pane")
    ) {
      return false;
    }
    const hdrs = this.selectedHdrs(win);
    if (!hdrs.some(hdr => this.isAllMail(hdr.folder))) {
      return false;
    }
    this.perform(win, command, hdrs, args[0]);
    return true;
  },

  handleDrop(win, pane, event) {
    const transfer = event.dataTransfer;
    if (transfer.dropEffect == "none" || !Array.from(transfer.mozTypesAt(0)).includes("text/x-moz-message")) {
      return false;
    }
    const hdrs = [];
    for (let i = 0; i < transfer.mozItemCount; i++) {
      hdrs.push(win.top.messenger.msgHdrFromURI(transfer.mozGetDataAt("text/x-moz-message", i)));
    }
    const row = event.target.closest?.("li");
    if (!row || !hdrs.some(hdr => this.isAllMail(hdr.folder))) {
      return false;
    }
    pane._timedExpand?.();
    pane._clearDropTarget?.();
    pane._clearDragTarget?.();
    if (pane._autoExpandedRows) {
      pane._autoExpandedRows.length = 0;
    }
    event.preventDefault();
    const target = MailServices.folderLookup.getFolderForURL(row.uri);
    const command = transfer.dropEffect == "move" ? "cmd_moveMessage" : "cmd_copyMessage";
    try {
      this.perform(win, command, hdrs, target);
    } catch (e) {
      this.failed(e);
    }
    return true;
  },

  handleRowEvent(win, event) {
    const view = win.gDBView;
    const index = event.detail.index;
    const hdr = view?.getMsgHdrAt(index);
    if (!hdr || !this.isAllMail(hdr.folder)) {
      return;
    }
    event.stopImmediatePropagation();
    let hdrs = [hdr];
    if (view.isContainer(index) && !view.isContainerOpen(index)) {
      // Like native, a collapsed thread stands for all of its messages.
      const thread = view.getThreadContainingIndex(index);
      hdrs = Array.from({ length: thread.numChildren }, (_, i) => thread.getChildHdrAt(i));
    }
    let command = "cmd_deleteMessage";
    if (event.type == "toggle-spam") {
      command = event.detail.isJunk ? "cmd_markAsNotJunk" : "cmd_markAsJunk";
    }
    try {
      this.perform(win, command, hdrs, null, { confirm: false });
    } catch (e) {
      this.failed(e);
    }
  },

  // ---- actions -------------------------------------------------------------

  /**
   * Map every header to the header in its real folder. All Mail headers are
   * resolved through the index, every other header stays as it is.
   *
   * @returns {{groups: Map<nsIMsgFolder, nsIMsgDBHdr[]>, failed: number}}
   */
  resolveReal(hdrs) {
    const groups = new Map();
    let failed = 0;
    for (const hdr of hdrs) {
      let real = hdr;
      if (this.isAllMail(hdr.folder)) {
        const account = this.accountFor(hdr.folder);
        real = this.verifiedMatch(account, hdr);
        if (!real) {
          failed++;
          const stale = core.staleUris(account.index.resolve(this.entryOf(hdr)));
          this.refreshFolders(account, stale, 30000).catch(console.error);
          continue;
        }
      }
      const list = groups.get(real.folder) ?? [];
      list.push(real);
      groups.set(real.folder, list);
    }
    return { groups, failed };
  },

  verifiedMatch(account, hdr) {
    const entry = this.entryOf(hdr);
    const result = account.index.resolve(entry);
    if (account.state == "indexing" || result.status != "unique") {
      return null;
    }
    const [{ uri, key }] = result.matches;
    const folder = MailServices.folderLookup.getFolderForURL(uri);
    try {
      const real = folder.msgDatabase.getMsgHdrForKey(key);
      if (
        real.messageId == entry.id &&
        core.sameSize(real.messageSize, entry.size) &&
        real.date == entry.date &&
        !(real.flags & Ci.nsMsgMessageFlags.IMAPDeleted)
      ) {
        return real;
      }
    } catch {}
    this.rescanLater(folder);
    return null;
  },

  perform(win, command, hdrs, destFolder, { confirm = true } = {}) {
    const { groups, failed } = this.resolveReal(hdrs);
    if (failed) {
      this.notice(
        `${failed} of ${hdrs.length} selected messages could not be matched to exactly one real folder. ` +
          "Nothing was changed. The folders involved are being synced again, so try again in a few seconds, " +
          "or use the real folder."
      );
      return;
    }
    const msgWindow = win.top.msgWindow;
    const allMailHdrs = hdrs.filter(hdr => this.isAllMail(hdr.folder));
    const realHdrs = [...groups.values()].flat();
    const touched = new Set(groups.keys());
    const done = () => this.afterAction(touched, allMailHdrs);
    const listener = this.copyListener(done);
    let moved = true;

    switch (command) {
      case "cmd_deleteMessage":
      case "cmd_shiftDeleteMessage": {
        const permanent = command == "cmd_shiftDeleteMessage";
        // Pass a Trash folder when any copy lives there, so its warning shows.
        const folders = [...groups.keys()];
        const folder =
          folders.find(f => f.isSpecialFolder(Flags.Trash, true)) ?? (folders.length == 1 ? folders[0] : win.gFolder);
        if (confirm && win.gDBView && !MailUtils.confirmDelete(permanent, win.gDBView, folder)) {
          return;
        }
        for (const [folder, list] of groups) {
          folder.deleteMessages(list, msgWindow, permanent, false, listener, !permanent);
        }
        break;
      }
      case "cmd_moveMessage":
      case "cmd_copyMessage": {
        if (this.isAllMail(destFolder)) {
          return;
        }
        const kind = this.accountFor(destFolder) ? this.describe(destFolder).kind : "real";
        const isMove = command == "cmd_moveMessage" && kind != "label";
        moved = isMove;
        for (const [folder, list] of groups) {
          if (folder != destFolder) {
            MailServices.copy.copyMessages(folder, list, destFolder, isMove, listener, msgWindow, true);
          }
        }
        touched.add(destFolder);
        Services.prefs.setStringPref("mail.last_msg_movecopy_target_uri", destFolder.URI);
        Services.prefs.setBoolPref("mail.last_msg_movecopy_was_move", command == "cmd_moveMessage");
        break;
      }
      case "cmd_archive": {
        const archiver = new MessageArchiver();
        archiver.msgWindow = msgWindow;
        archiver.oncomplete = done;
        archiver.archiveMessages(realHdrs);
        break;
      }
      case "cmd_markAsJunk":
        moved = this.markJunk(groups, allMailHdrs, msgWindow, listener);
        break;
      case "cmd_markAsNotJunk":
        moved = false;
        this.markNotJunk(groups, allMailHdrs, msgWindow, listener);
        break;
    }
    // Native code may have prepared a selection jump for a row removal that
    // does not happen now (cmd_moveToFolderAgain does this).
    if (win.dbViewWrapperListener) {
      win.dbViewWrapperListener._nextViewIndexAfterDelete = null;
    }
    if (moved) {
      this.advance(win, hdrs);
    }
  },

  /** @returns {boolean} true when messages were moved or deleted. */
  markJunk(groups, allMailHdrs, msgWindow, listener) {
    let moved = false;
    const markRead = Services.prefs.getBoolPref("mailnews.ui.junk.manualMarkAsJunkMarksRead", true);
    for (const [folder, list] of groups) {
      if (markRead) {
        folder.markMessagesRead(list, true);
      }
      folder.setJunkScoreForMessages(list, "100", "user", -1);
      const settings = folder.server.spamSettings;
      if (!settings?.manualMark || this.isJunkFolder(folder)) {
        continue;
      }
      if (settings.manualMarkMode == Ci.nsISpamSettings.MANUAL_MARK_MODE_DELETE) {
        folder.deleteMessages(list, msgWindow, false, false, listener, true);
        moved = true;
        continue;
      }
      const junk = this.junkFolder(folder);
      if (junk) {
        MailServices.copy.copyMessages(folder, list, junk, true, listener, msgWindow, true);
        moved = true;
      }
    }
    this.setScoreOnAllMail(allMailHdrs, "100", markRead);
    return moved;
  },

  markNotJunk(groups, allMailHdrs, msgWindow, listener) {
    for (const [folder, list] of groups) {
      folder.setJunkScoreForMessages(list, "0", "user", -1);
      const inbox = folder.rootFolder.getFolderWithFlags(Flags.Inbox);
      if (this.isJunkFolder(folder) && inbox) {
        MailServices.copy.copyMessages(folder, list, inbox, true, listener, msgWindow, true);
      }
    }
    this.setScoreOnAllMail(allMailHdrs, "0", false);
  },

  setScoreOnAllMail(hdrs, score, markRead) {
    for (const [folder, list] of this.byFolder(hdrs)) {
      if (markRead) {
        folder.markMessagesRead(list, true);
      }
      folder.setJunkScoreForMessages(list, score, "user", -1);
    }
  },

  byFolder(hdrs) {
    const groups = new Map();
    for (const hdr of hdrs) {
      groups.set(hdr.folder, [...(groups.get(hdr.folder) ?? []), hdr]);
    }
    return groups;
  },

  isJunkFolder(folder) {
    return folder.getFlag(Flags.Junk) || folder == this.junkFolder(folder);
  },

  junkFolder(folder) {
    const uri = folder.server.spamSettings?.spamFolderURI;
    // The lookup also returns detached folders for URIs that do not exist.
    const configured = uri && MailUtils.getExistingFolder(uri);
    if (configured?.parent && configured.server == folder.server) {
      return configured;
    }
    return (
      folder.rootFolder.getFolderWithFlags(Flags.Junk) ?? folder.rootFolder.subFolders.find(f => f.name == "Spam")
    );
  },

  copyListener(onDone) {
    return {
      QueryInterface: ChromeUtils.generateQI(["nsIMsgCopyServiceListener"]),
      onStartCopy() {},
      onProgress() {},
      setMessageKey() {},
      getMessageId() {
        return "";
      },
      onStopCopy: onDone,
    };
  },

  afterAction(folders, allMailHdrs) {
    for (const folder of folders) {
      this.rescanLater(folder);
    }
    for (const allMail of this.byFolder(allMailHdrs).keys()) {
      if (allMail.server.type == "imap") {
        this.debounce(`update:${allMail.URI}`, 1500, () => this.updateFolder(allMail));
      }
    }
    this.refreshColumns();
  },

  /**
   * Native code advances when rows disappear. All Mail keeps the rows, so do it
   * here: next row in the 3-pane, close or next message in a message tab or window.
   */
  advance(win, hdrs) {
    if (win.location.href.startsWith("about:message")) {
      if (win.parent?.location.href.startsWith("about:3pane")) {
        return;
      }
      if (Services.prefs.getBoolPref("mail.close_message_window.on_delete", false)) {
        const tabmail = win.top.document.getElementById("tabmail");
        tabmail ? tabmail.closeTab(win.tabOrWindow) : win.top.close();
      } else {
        win.commandController.doCommand("cmd_nextMsg");
      }
      return;
    }
    const view = win.gDBView;
    if (!view || !win.threadTree) {
      return;
    }
    const rows = hdrs.map(hdr => view.findIndexOfMsgHdr(hdr, false)).filter(i => i >= 0 && i < view.rowCount);
    if (!rows.length) {
      return;
    }
    const after = Math.max(...rows) + 1;
    const before = Math.min(...rows) - 1;
    const next = after < view.rowCount ? after : before;
    if (next >= 0) {
      win.threadTree.selectedIndex = next;
    }
  },

  // ---- status --------------------------------------------------------------

  status() {
    const detected = this.started ? this.detectAccounts() : [];
    return {
      lastNotice: this.lastNotice,
      accounts: detected.map(({ server, enabled }) => {
        const account = this.accounts.get(server.key);
        return {
          key: server.key,
          name: server.prettyName,
          enabled,
          state: account?.state ?? (enabled ? "pending" : "disabled"),
          lastSync: account?.lastSync ?? null,
          coverage: account?.coverage ?? null,
          unreadable: [...(account?.unreadable ?? [])],
          error: account?.error ?? "",
          ...(account?.index.stats() ?? { folders: 0, messages: 0 }),
        };
      }),
    };
  },
};

this.allMailPlus = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (!isAppShutdown) {
      controller.stop();
    }
  }

  getAPI(context) {
    return {
      allMailPlus: {
        start: async config => controller.start(context.extension, config),
        configure: async config => controller.configure(config),
        getStatus: async () => controller.status(),
        rebuild: async () => {
          await controller.rebuild(false);
          return controller.status();
        },
        syncNow: async () => controller.syncAll(),
        onNotice: new ExtensionCommon.EventManager({
          context,
          name: "allMailPlus.onNotice",
          register: fire => {
            const listener = (event, text) => fire.async(text);
            emitter.on("notice", listener);
            return () => emitter.off("notice", listener);
          },
        }).api(),
      },
    };
  }
};

