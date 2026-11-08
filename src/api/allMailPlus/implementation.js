/* Experiment API: location index, thread pane columns and All Mail action routing. */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { MailUtils } = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs");
var { MessageArchiver } = ChromeUtils.importESModule("resource:///modules/MessageArchiver.sys.mjs");
var { VirtualFolderHelper } = ChromeUtils.importESModule("resource:///modules/VirtualFolderWrapper.sys.mjs");
var { ThreadPaneColumns } = ChromeUtils.importESModule("chrome://messenger/content/ThreadPaneColumns.mjs");
var { setTimeout, clearTimeout, setInterval, clearInterval } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const LOCATION_COLUMN = "allMailPlusLocation";
const LABELS_COLUMN = "allMailPlusLabels";
const INIT_PROPERTY = "allMailPlusColumnsInit";
const SEARCH_MARK = "allMailBuddySavedSearch"; // folder property of the saved search

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
const SEARCH_CHUNK = 100; // Message-IDs per IMAP SEARCH
const REPAIR_LIMIT = 25; // folders per click on "Repair folders"
const MAX_SEARCH_IDS = 500; // Message-IDs per server check run
const VERIFY_LABEL = "Check each message on the server before acting on it"; // as in the settings
const STATE_PREF = "extensions.allmailplus.serverCheck"; // JSON, see checkState()
const resourceHandler = () =>
  Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsISubstitutingProtocolHandler);

const Flags = Ci.nsMsgFolderFlags;
// Milliseconds with sub-millisecond precision where available, for diagnostics.
const preciseNow = () => {
  try {
    return Components.utils.now();
  } catch {
    return Date.now();
  }
};
const mfn = Ci.nsIMsgFolderNotificationService;

let core = null;
let searchTerm = null;
const emitter = new ExtensionCommon.EventEmitter();

const controller = {
  started: false,
  config: {
    syncOnStartup: true,
    checkIntervalMinutes: 5,
    dailyServerCheck: true,
    verifyOnServer: true,
    diagnostics: false,
    disabledAccounts: [],
  },
  accounts: new Map(), // server key -> account state
  unhooks: new Set(),
  timers: new Map(),
  timerStarts: new Map(), // debounce name -> time of the first call since it last ran
  scanning: new Set(), // folder uris whose snapshot is being taken
  dirty: new Set(), // folder uris that changed during their snapshot
  pendingSync: false,
  refreshedAt: new Map(), // folder uri -> time of the last targeted sync
  checkTimer: null,
  statusSeen: new Map(), // folder uri -> "MESSAGES/UIDNEXT" from the last STATUS check
  loadWaiters: new Map(), // folder uri -> callback for its next FolderLoaded
  serverChecks: new Set(), // server keys with a running server check or repair
  repairing: new Set(), // server keys whose folders are being repaired; syncs pause meanwhile
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
    searchTerm = ChromeUtils.importESModule(`resource://${RESOURCE_HOST}/lib/searchTerm.sys.mjs`);
    searchTerm.setImplementation(this.searchTermImpl());
    MailServices.mfn.addListener(
      this.folderListener,
      mfn.msgAdded | mfn.msgsDeleted | mfn.msgsMoveCopyCompleted | mfn.msgKeyChanged |
        mfn.folderAdded | mfn.folderDeleted | mfn.folderMoveCopyCompleted | mfn.folderRenamed
    );
    MailServices.mailSession.AddFolderListener(
      this.loadListener,
      Ci.nsIFolderListener.event | Ci.nsIFolderListener.propertyFlagChanged
    );
    Services.obs.addObserver(this, "chrome-document-global-created");
    Services.obs.addObserver(this, STATUS_TOPIC);
    this.hookExistingWindows();
    this.rebuild(this.config.syncOnStartup);
    this.scheduleCheck();
    return this.status();
  },

  stop() {
    if (!this.started) {
      return;
    }
    this.started = false;
    searchTerm?.setImplementation(null);
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
    this.timerStarts.clear();
    this.scanning.clear();
    this.dirty.clear();
    this.refreshedAt.clear();
    clearTimeout(this.checkTimer);
    this.statusSeen.clear();
    for (const done of [...this.loadWaiters.values()]) {
      done();
    }
    this.serverChecks.clear();
    this.repairing.clear();
    clearInterval(this.diag.timer);
    this.diag.timer = null;
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
    this.scheduleCheck();
    this.updateMonitor();
    return this.status();
  },

  // ---- diagnostics -------------------------------------------------------------

  diag: { log: [], active: new Map(), timer: null, last: 0, matches: 0, matchMs: 0, matchStart: 0 },

  diagnose(text) {
    if (!this.config.diagnostics) {
      return;
    }
    const t = new Date();
    const stamp = `${t.toLocaleTimeString()}.${String(t.getMilliseconds()).padStart(3, "0")}`;
    this.diag.log.push(`${stamp}  ${text}`);
    if (this.diag.log.length > 500) {
      this.diag.log.shift();
    }
  },

  /** Runs fn and, with diagnostics on, records how long it took and that it was running. */
  async timed(label, fn) {
    if (!this.config.diagnostics) {
      return fn();
    }
    const id = {};
    const start = preciseNow();
    this.diag.active.set(id, label);
    try {
      return await fn();
    } finally {
      this.diag.active.delete(id);
      const ms = preciseNow() - start;
      if (ms >= 100) {
        this.diagnose(`${label}: ${Math.round(ms)} ms`);
      }
    }
  },

  /** With diagnostics on, notices when Thunderbird stops responding and what the add-on was doing. */
  updateMonitor() {
    clearInterval(this.diag.timer);
    this.diag.timer = null;
    if (!this.started || !this.config.diagnostics) {
      return;
    }
    this.diag.last = preciseNow();
    this.diag.timer = setInterval(() => {
      const now = preciseNow();
      const lag = now - this.diag.last - 200;
      this.diag.last = now;
      if (lag > 300) {
        const active = [...new Set(this.diag.active.values())].join(", ") || "none";
        this.diagnose(`STALL: Thunderbird did not respond for ${Math.round(lag)} ms. Add-on work in progress: ${active}`);
      }
      if (this.diag.matches && now - this.diag.matchStart > 1000) {
        this.diagnose(
          `Search criterion: ${this.diag.matches} messages checked, ${Math.round(this.diag.matchMs)} ms in the add-on`
        );
        this.diag.matches = 0;
        this.diag.matchMs = 0;
      }
    }, 200);
  },

  failed(error) {
    console.error("All Mail Buddy:", error);
    this.notice(`The action failed: ${error.message}. Some messages may already have been changed.`);
  },

  notice(text) {
    Services.console.logStringMessage(`All Mail Buddy: ${text}`);
    this.lastNotice = text;
    emitter.emit("notice", text);
  },

  /**
   * Runs fn once calls stop for ms. With maxWait, calls after maxWait no longer
   * postpone it, so it runs at most maxWait + ms after the first call; the
   * pending fn is kept, so callers with maxWait must not capture changing state.
   */
  debounce(name, ms, fn, maxWait = Infinity) {
    const first = this.timerStarts.get(name) ?? Date.now();
    if (this.timers.has(name) && Date.now() - first >= maxWait) {
      return;
    }
    clearTimeout(this.timers.get(name));
    this.timerStarts.set(name, first);
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        this.timerStarts.delete(name);
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
        serverCheck: previous.get(server.key)?.serverCheck ?? null,
        // Real folders whose local list was loaded from the server in this session.
        synced: previous.get(server.key)?.synced ?? new Set(),
        realUris: new Set(),
        fullySynced: false,
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
        account.realUris = new Set(
          this.trackedFolders(account)
            .filter(f => this.describe(f).kind == "real")
            .map(f => f.URI)
        );
        this.updateSynced(account);
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

  /** Records that a folder's local list was just loaded from the server. */
  markSynced(folder) {
    const account = this.accountFor(folder);
    if (account) {
      account.synced.add(folder.URI);
      this.updateSynced(account);
    }
  },

  /**
   * "No folder" is only trusted once every real folder was loaded from the
   * server in this session; before that a folder may simply be unsynced.
   */
  updateSynced(account) {
    const before = account.fullySynced;
    account.fullySynced =
      account.server.type != "imap" || [...account.realUris].every(uri => account.synced.has(uri));
    if (!before && account.fullySynced && account.state == "ready") {
      this.coverageLater(account);
      this.refreshColumns();
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

  scanFolder(account, folder) {
    return this.timed(`read ${this.describe(folder).name}`, () => this.readFolder(account, folder));
  },

  async readFolder(account, folder) {
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
      if (i % 500 == 499) {
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
    // A rebuild may replace the account meanwhile; count the current one. Steady
    // folder activity must not postpone the count forever.
    this.debounce(
      `coverage:${account.key}`,
      2000,
      () => {
        const current = this.accounts.get(account.key);
        // Rebuild and sync count again when they finish.
        if (current?.state == "ready") {
          this.updateCoverage(current);
        }
      },
      10000
    );
  },

  /**
   * Counts how All Mail resolves. For messages without a match it records why,
   * and how far size (bytes) and date (seconds) are off from the closest copy.
   */
  updateCoverage(account) {
    return this.timed(`count All Mail of ${account.name}`, () => this.countCoverage(account));
  },

  async countCoverage(account) {
    const coverage = {
      unique: 0,
      ambiguous: 0,
      missing: 0,
      nofolder: 0, // Proton keeps these only in All Mail
      reasons: {},
      sizeDeltas: {},
      dateDeltas: {},
      examples: [], // a few messages without any real folder, to look them up in Proton
    };
    const count = (map, key) => (map[key] = (map[key] ?? 0) + 1);
    const stale = new Set();
    const orphanIds = new Set();
    const differing = new Map(); // real folder uri -> All Mail entries whose copy there differs
    const doubled = new Map(); // real folder uri -> All Mail entries that match several real copies
    let selfSent = 0; // ambiguous messages with a copy in Sent, most likely sent to yourself
    const sent = new Map();
    const isSent = uri => {
      if (!sent.has(uri)) {
        const folder = MailServices.folderLookup.getFolderForURL(uri);
        sent.set(uri, !!folder && (folder.isSpecialFolder(Flags.SentMail, true) || folder.name == "Sent"));
      }
      return sent.get(uri);
    };
    const remember = (map, uri, entry) => {
      const list = map.get(uri) ?? [];
      if (list.length < 50) {
        list.push(entry);
      }
      map.set(uri, list);
    };
    try {
      const db = account.allMail.msgDatabase;
      const keys = db.listAllKeys();
      for (let i = 0; i < keys.length; i++) {
        if (i % 500 == 499) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const hdr = db.getMsgHdrForKey(keys[i]);
        const entry = this.entryOf(hdr);
        const result = account.index.resolve(entry);
        coverage[result.status]++;
        core.staleUris(result).forEach(uri => stale.add(uri));
        if (result.status == "nofolder") {
          orphanIds.add(entry.id);
          if (coverage.examples.length < 5) {
            coverage.examples.push(this.describeHdr(hdr));
          }
        }
        if (result.status == "ambiguous") {
          // Proton really keeps a message you sent to yourself twice; a repair cannot change that.
          if (result.matches.some(m => isSent(m.uri))) {
            selfSent++;
          } else {
            result.matches.forEach(m => remember(doubled, m.uri, entry));
          }
        }
        if (result.status == "missing") {
          count(coverage.reasons, result.reason);
          result.candidates.forEach(c => remember(differing, c.uri, entry));
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
    const state = this.checkState();
    const fixable = [...differing.keys()].filter(uri => !core.knownUnfixable(state.unfixable[uri], Date.now()));
    coverage.differingFolders = fixable.length;
    coverage.differingNames = fixable.slice(0, REPAIR_LIMIT).map(uri => account.index.folders.get(uri)?.name ?? uri);
    coverage.unfixableFolders = differing.size - fixable.length;
    const fixableDoubled = [...doubled.keys()].filter(
      uri => !core.knownUnfixable(state.unfixable[`ambiguous:${uri}`], Date.now())
    );
    coverage.ambiguousSelf = selfSent;
    coverage.ambiguousFolders = fixableDoubled.length;
    coverage.ambiguousNames = fixableDoubled.slice(0, REPAIR_LIMIT).map(uri => account.index.folders.get(uri)?.name ?? uri);
    coverage.ambiguousUnfixable = doubled.size - fixableDoubled.length;
    coverage.fullySynced = account.fullySynced;
    account.coverage = coverage;
    account.orphanIds = orphanIds;
    account.differing = differing;
    account.differingUris = new Set(fixable);
    account.doubled = doubled;
    account.doubledUris = new Set(fixableDoubled);
    this.refreshFolders(account, stale, 10 * 60000).catch(console.error);
    const due = core.serverCheckDue({
      // Messages in folders that were not synced yet only look folderless.
      enabled: this.config.dailyServerCheck && account.fullySynced,
      nofolder: coverage.nofolder,
      last: this.checkState().last[account.server.key] ?? 0,
      now: Date.now(),
    });
    if (due && account.state == "ready") {
      this.checkServer(account, { auto: true }).catch(console.error);
    }
  },

  describeHdr(hdr) {
    return { subject: hdr.mime2DecodedSubject, author: hdr.mime2DecodedAuthor, date: hdr.date / 1000 };
  },

  /** Every All Mail message without exactly one real copy, with the reason. */
  problems(account) {
    return this.timed("list affected messages", () => this.listProblems(account));
  },

  async listProblems(account) {
    const list = [];
    const db = account.allMail.msgDatabase;
    const signed = n => `${n > 0 ? "+" : ""}${n}`;
    const keys = db.listAllKeys();
    for (let i = 0; i < keys.length; i++) {
      if (i % 500 == 499) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const hdr = db.getMsgHdrForKey(keys[i]);
      const entry = this.entryOf(hdr);
      const result = account.index.resolve(entry);
      if (result.status == "unique") {
        continue;
      }
      let detail = "";
      if (result.status == "ambiguous") {
        detail = result.location;
      } else if (result.status == "missing") {
        const [closest] = result.candidates;
        const names = [...new Set(result.candidates.map(c => account.index.folders.get(c.uri).name))];
        const off = [];
        if (closest.size != entry.size) {
          off.push(`${signed(closest.size - entry.size)} bytes`);
        }
        if (closest.date != entry.date) {
          off.push(`${signed(Math.round((closest.date - entry.date) / 1e6))} s`);
        }
        detail = `${names.join(", ")}: ${off.join(", ")}`;
      } else if (result.labels.length) {
        detail = `Labels: ${result.labels.join(", ")}`;
      }
      list.push({ ...this.describeHdr(hdr), uri: hdr.folder.getUriForMsg(hdr), problem: result.status, detail });
    }
    return list.sort((a, b) => b.date - a.date);
  },

  /**
   * Syncs folders that look out of date and rescans them. Each folder is synced
   * at most once per minAge, which also stops coverage and refresh from looping.
   */
  async refreshFolders(account, uris, minAge) {
    const current = () => this.accounts.get(account.key) === account && !this.repairing.has(account.server.key);
    if (account.server.type != "imap" || !current()) {
      return;
    }
    const now = Date.now();
    const due = [...uris].filter(uri => now - (this.refreshedAt.get(uri) ?? 0) > minAge).slice(0, 25);
    for (const uri of due) {
      this.refreshedAt.set(uri, now);
      const folder = MailServices.folderLookup.getFolderForURL(uri);
      if (folder && account.index.hasFolder(uri) && current()) {
        if (await this.updateFolder(folder)) {
          this.markSynced(folder);
        }
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
          console.error("All Mail Buddy:", e);
        } finally {
          this.scheduleCheck();
        }
      }, Math.min(60, Math.max(1, Number(this.config.checkIntervalMinutes) || 5)) * 60000);
    }
  },

  async checkChanges(account) {
    const busy = account.checking || this.repairing.has(account.server.key);
    if (account.server.type != "imap" || account.state != "ready" || busy) {
      return;
    }
    account.checking = true;
    account.checkedAt = Date.now();
    try {
      await this.timed(`change check of ${account.name}`, () => this.syncChangedFolders(account));
    } finally {
      // A slow check loads All Mail late; that load must not start another one.
      account.checkedAt = Date.now();
      account.checking = false;
    }
  },

  async syncChangedFolders(account) {
    const changed = [];
    for (const folder of [...this.trackedFolders(account), account.allMail]) {
      const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
      if (!(await this.urlDone(listener => imap.updateStatus(listener, null), 15000))) {
        continue; // no answer: neither synced nor changed
      }
      const status = { total: imap.serverTotal, nextUid: imap.serverNextUID };
      const seen = `${status.total}/${status.nextUid}`;
      const previous = this.statusSeen.get(folder.URI) ?? null;
      this.statusSeen.set(folder.URI, seen);
      if (core.needsSync({ previous, ...status, localCount: folder.getTotalMessages(false) })) {
        changed.push(folder);
      } else {
        this.markSynced(folder);
      }
    }
    for (const folder of changed) {
      if (await this.updateFolder(folder)) {
        this.markSynced(folder);
      }
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

  // ---- server check ----------------------------------------------------------

  /** Persistent check state: {last: {serverKey: ms}, repaired: {folderUri: ms}}. */
  checkState() {
    try {
      return { last: {}, repaired: {}, unfixable: {}, ...JSON.parse(Services.prefs.getStringPref(STATE_PREF, "{}")) };
    } catch {
      return { last: {}, repaired: {}, unfixable: {} };
    }
  },

  saveCheckState(state) {
    Services.prefs.setStringPref(STATE_PREF, JSON.stringify(state));
  },

  /**
   * Looks up every message without a folder on the server, with one IMAP
   * SEARCH per real folder and batch of Message-IDs. A hit whose local header
   * is another message shows a local list that no longer matches the server.
   * Only those folders are repaired, the way Thunderbird's own "Repair Folder"
   * does it; folders that have the message are rescanned. The daily run does
   * not repair the same folder again within a week.
   */
  checkServer(account, options) {
    return this.timed(`server check of ${account.name}`, () => this.runServerCheck(account, options));
  },

  async runServerCheck(account, { auto = false } = {}) {
    const key = account.server.key;
    if (account.server.type != "imap" || account.state != "ready" || this.serverChecks.has(key)) {
      return;
    }
    // Thunderbird makes up "md5:" IDs for messages without one; the server has no such header.
    // One run looks up at most MAX_SEARCH_IDS messages, the next run continues with the rest.
    const all = [...(account.orphanIds ?? [])].filter(id => !id.startsWith("md5:"));
    const offset = (account.searchOffset ?? 0) % Math.max(all.length, 1);
    const ids = [...all.slice(offset), ...all.slice(0, offset)].slice(0, MAX_SEARCH_IDS);
    account.searchOffset = offset + ids.length;
    const report = {
      running: true,
      auto,
      startedAt: Date.now(),
      finishedAt: 0,
      messages: ids.length,
      total: all.length,
      folders: 0,
      searched: 0,
      failed: 0,
      repaired: [],
      rescanned: [],
      skipped: [],
      error: "",
    };
    account.serverCheck = report;
    const state = this.checkState();
    state.last[key] = Date.now();
    this.saveCheckState(state);
    if (Services.io.offline) {
      Object.assign(report, { running: false, finishedAt: Date.now(), error: "Thunderbird is offline." });
      return;
    }
    this.serverChecks.add(key);
    const alive = () => this.started && this.accounts.get(key) === account;
    const errors = [];
    try {
      const folders = ids.length ? this.trackedFolders(account).filter(f => this.describe(f).kind == "real") : [];
      report.folders = folders.length;
      const broken = new Set();
      const stale = new Set();
      const dbService = Cc["@mozilla.org/msgDatabase/msgDBService;1"].getService(Ci.nsIMsgDBService);
      for (const folder of folders) {
        const wasOpen = !!dbService.cachedDBForFolder(folder);
        for (let i = 0; i < ids.length; i += SEARCH_CHUNK) {
          if (!alive()) {
            return;
          }
          const searched = new Set(ids.slice(i, i + SEARCH_CHUNK));
          const { hits, ok } = await this.searchOnline(folder, searched);
          report.failed += ok ? 0 : 1;
          for (const { id } of hits) {
            const verdict = core.hitVerdict(searched, id);
            if (verdict) {
              (verdict == "broken" ? broken : stale).add(folder);
            }
          }
        }
        if (!wasOpen) {
          try {
            folder.closeDBIfFolderNotOpen(false);
          } catch {}
        }
        report.searched++;
      }
      // Only the repairs pause syncs; change checks keep running during the searches.
      const loaded = new Set();
      this.repairing.add(key);
      try {
        for (const folder of broken) {
          if (!alive()) {
            return;
          }
          const name = this.describe(folder).name;
          const now = Date.now();
          if (folder.locked || folder.getFlag(Flags.OfflineEvents)) {
            // Busy, or holds changes made offline that a repair would drop.
            report.skipped.push(`${name} (busy)`);
          } else if (!core.mayRepair({ auto, repairedAt: state.repaired[folder.URI], now })) {
            report.skipped.push(`${name} (repaired this week)`);
          } else {
            try {
              if (await this.repairFolder(folder)) {
                loaded.add(folder);
              }
              report.repaired.push(name);
              state.repaired[folder.URI] = now;
              this.saveCheckState(state);
            } catch (e) {
              errors.push(`${name}: ${e.message}`);
            }
          }
        }
      } finally {
        this.repairing.delete(key);
      }
      // A repair that is still loading is rescanned when its folder finishes loading.
      for (const folder of new Set([...stale, ...loaded])) {
        if (alive()) {
          await this.scanFolder(account, folder);
        }
      }
      report.rescanned = [...stale].filter(f => !broken.has(f)).map(f => this.describe(f).name);
    } catch (e) {
      errors.push(String(e));
      console.error("All Mail Buddy:", e);
    } finally {
      if (report.failed) {
        errors.unshift(`${report.failed} searches failed or timed out`);
      }
      if (!alive()) {
        errors.unshift("interrupted by a folder change or by stopping the add-on");
      }
      report.error = errors.join("; ");
      report.running = false;
      report.finishedAt = Date.now();
      this.serverChecks.delete(key);
      if (alive()) {
        this.coverageLater(account);
        this.refreshColumns();
      }
    }
  },

  /** @returns {Promise<{hits: {id: string, key: number}[], ok: boolean}>} local headers the server search hit */
  searchOnline(folder, ids) {
    return new Promise(resolve => {
      const attrib = Ci.nsMsgSearchAttrib.OtherHeader + 1; // any custom header
      const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(Ci.nsIMsgSearchSession);
      session.addScopeTerm(Ci.nsMsgSearchScope.onlineMail, folder);
      for (const id of ids) {
        const term = session.createTerm();
        const value = term.value;
        value.attrib = attrib;
        value.str = id;
        term.attrib = attrib;
        term.arbitraryHeader = "Message-ID";
        term.op = Ci.nsMsgSearchOp.Contains;
        term.value = value;
        term.booleanAnd = false;
        session.appendTerm(term);
      }
      const hits = [];
      let finished = false;
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchNotify"]),
        onSearchHit(hdr) {
          hits.push({ id: hdr.messageId, key: hdr.messageKey });
        },
        onSearchDone: status => done(Components.isSuccessCode(status)),
        onResetSearch() {},
        onNewSearch() {},
      };
      const done = ok => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          session.unregisterListener(listener);
          resolve({ hits, ok });
        }
      };
      const timer = setTimeout(() => done(false), 120000);
      session.registerListener(listener);
      try {
        // No window: background searches should not report into the user's window.
        session.search(null);
      } catch (e) {
        console.error("All Mail Buddy: search failed in", folder.URI, e);
        done(false);
      }
    });
  },

  msgWindow() {
    return Services.wm.getMostRecentWindow("mail:3pane")?.msgWindow ?? null;
  },

  /** Thunderbird's own "Repair Folder" (about3Pane up to 15x, FolderCommands later). */
  rebuildFolderSummary() {
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      for (const tab of win.document.getElementById("tabmail")?.tabInfo ?? []) {
        const pane = tab.chromeBrowser?.contentWindow?.folderPane;
        if (pane?.rebuildFolderSummary) {
          return folder => pane.rebuildFolderSummary(folder);
        }
      }
    }
    try {
      const { FolderCommands } = ChromeUtils.importESModule("chrome://messenger/content/FolderCommands.mjs");
      if (FolderCommands?.rebuildFolderSummary) {
        return folder => FolderCommands.rebuildFolderSummary(folder);
      }
    } catch {}
    return null;
  },

  /**
   * Repairs a folder, then waits until it is loaded again.
   *
   * @returns {Promise<boolean>} false when it did not finish loading in time
   */
  repairFolder(folder) {
    return this.timed(`repair ${this.describe(folder).name}`, () => this.runRepair(folder));
  },

  async runRepair(folder) {
    const rebuild = this.rebuildFolderSummary();
    if (!rebuild) {
      throw new Error("no mail window is open to repair folders in");
    }
    const loaded = new Promise(resolve => {
      const done = ok => {
        clearTimeout(timer);
        this.loadWaiters.delete(folder.URI);
        resolve(!!ok);
      };
      const timer = setTimeout(() => done(false), 180000);
      this.loadWaiters.set(folder.URI, done);
    });
    await rebuild(folder);
    return loaded;
  },

  /**
   * Repairs the folders that hold a copy with another size or date than its
   * All Mail message ("missing"), or one of several matching copies
   * ("ambiguous"), so Thunderbird loads their lists from the server again.
   */
  async repairDifferingFolders(key, kind = "missing") {
    const result = { repaired: [], skipped: [], errors: [], unfixable: [], busy: "" };
    const account = this.accounts.get(key);
    if (Services.io.offline) {
      result.busy = "Thunderbird is offline";
      return result;
    }
    if (!account || account.state != "ready" || this.serverChecks.has(key)) {
      result.busy = "the account is syncing, indexing or being checked";
      return result;
    }
    // Pauses syncs and change checks, as during a server check.
    this.serverChecks.add(key);
    this.repairing.add(key);
    const alive = () => this.started && this.accounts.get(key) === account;
    const state = this.checkState();
    const ambiguous = kind == "ambiguous";
    const uris = (ambiguous ? account.doubledUris : account.differingUris) ?? [];
    const entries = (ambiguous ? account.doubled : account.differing) ?? new Map();
    const stateKey = uri => (ambiguous ? `ambiguous:${uri}` : uri);
    try {
      for (const uri of [...uris].slice(0, REPAIR_LIMIT)) {
        const folder = MailServices.folderLookup.getFolderForURL(uri);
        if (!folder || !alive()) {
          continue;
        }
        const name = this.describe(folder).name;
        const now = Date.now();
        if (folder.locked || folder.getFlag(Flags.OfflineEvents)) {
          result.skipped.push(`${name} (busy)`);
        } else if (core.repairedRecently(state.repaired[uri], now)) {
          result.skipped.push(`${name} (repaired today)`);
        } else {
          try {
            const loaded = await this.repairFolder(folder);
            result.repaired.push(name);
            state.repaired[uri] = now;
            if (!loaded) {
              result.errors.push(`${name}: still loading, it is checked again when it has finished`);
            } else {
              await this.scanFolder(account, folder);
              // What survives a repair is real: do not offer this folder again for a while.
              const still = (entries.get(uri) ?? []).some(entry => {
                const r = account.index.resolve(entry);
                const refs = ambiguous ? r.matches : r.candidates;
                return r.status == kind && refs.some(c => c.uri == uri);
              });
              if (still) {
                state.unfixable[stateKey(uri)] = now;
                result.unfixable.push(name);
              }
            }
            this.saveCheckState(state);
          } catch (e) {
            result.errors.push(`${name}: ${e.message}`);
          }
        }
      }
    } finally {
      this.serverChecks.delete(key);
      this.repairing.delete(key);
      if (alive()) {
        this.coverageLater(account);
        this.refreshColumns();
      }
    }
    return result;
  },

  /** Server folders (from a full LIST, like the Subscribe dialog) that Thunderbird does not have. */
  async serverFolders(account) {
    if (account.server.type != "imap") {
      return [];
    }
    const server = account.server.QueryInterface(Ci.nsISubscribableServer);
    const found = [];
    try {
      const complete = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 60000);
        server.subscribeListener = {
          QueryInterface: ChromeUtils.generateQI(["nsISubscribeListener"]),
          OnDonePopulating() {
            clearTimeout(timer);
            resolve(true);
          },
        };
        server.startPopulating(null, true, false);
      });
      if (!complete) {
        throw new Error("the server did not send its folder list in time");
      }
      const walk = path => {
        for (const child of server.getChildURIs(path)) {
          found.push({ path: child, subscribed: server.isSubscribed(child), selectable: server.isSubscribable(child) });
          if (server.hasChildren(child)) {
            walk(child);
          }
        }
      };
      walk("");
    } finally {
      server.subscribeListener = null;
      server.subscribeCleanup();
    }
    // The subscribe tree always uses "/" between levels.
    const local = account.root.descendants.map(folder => {
      try {
        const imap = folder.QueryInterface(Ci.nsIMsgImapMailFolder);
        const delimiter = imap.hierarchyDelimiter;
        return delimiter && delimiter != "/" ? imap.onlineName.replaceAll(delimiter, "/") : imap.onlineName;
      } catch {
        return "";
      }
    });
    const missing = core.missingFolders(found.filter(f => f.selectable).map(f => f.path), local);
    return missing.map(path => ({ path, subscribed: found.find(f => f.path == path).subscribed }));
  },

  // ---- syncing -------------------------------------------------------------

  syncAll() {
    return this.timed("sync all folders", () => this.runSyncAll());
  },

  async runSyncAll() {
    for (const account of [...this.accounts.values()]) {
      // Folders being repaired must not be synced at the same time.
      if (account.state != "ready" || this.repairing.has(account.server.key)) {
        continue;
      }
      account.state = "syncing";
      try {
        const folders = [...this.trackedFolders(account), account.allMail];
        for (const folder of folders) {
          // A repair that starts meanwhile must not overlap the sync.
          if (this.repairing.has(account.server.key)) {
            break;
          }
          if (account.server.type == "imap" && (await this.updateFolder(folder))) {
            this.markSynced(folder);
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
    return this.timed(`load ${this.describe(folder).name} from the server`, () =>
      this.urlDone(listener => folder.updateFolderWithListener(null, listener), 60000)
    );
  },

  /** Runs an IMAP operation that reports through an nsIUrlListener, with a timeout. */
  /** @returns {Promise<boolean>} true when the URL finished successfully in time */
  urlDone(start, timeout) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeout);
      const done = ok => {
        clearTimeout(timer);
        resolve(ok);
      };
      try {
        start({
          QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
          OnStartRunningUrl() {},
          OnStopRunningUrl: (url, exitCode) => done(Components.isSuccessCode(exitCode)),
        });
      } catch {
        done(false);
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
    // With "Just mark it as deleted", a delete only sets a flag and sends no
    // msgsDeleted, so the index follows the flag.
    onFolderPropertyFlagChanged(item, property, oldFlag, newFlag) {
      const deleted = Ci.nsMsgMessageFlags.IMAPDeleted;
      if (!((oldFlag ^ newFlag) & deleted)) {
        return;
      }
      let hdr;
      try {
        hdr = item.QueryInterface(Ci.nsIMsgDBHdr);
      } catch {
        return;
      }
      if (newFlag & deleted) {
        controller.indexRemove([hdr]);
      } else {
        controller.indexAdd([hdr]);
      }
    },
    onFolderEvent(folder, event) {
      if (event != "FolderLoaded") {
        return;
      }
      controller.loadWaiters.get(folder.URI)?.(true);
      controller.markSynced(folder);
      if (controller.config.diagnostics && controller.accountFor(folder)) {
        controller.diagnose(`Thunderbird finished loading ${folder.prettyName}`);
      }
      if (controller.isAllMail(folder)) {
        const account = controller.accountFor(folder);
        controller.coverageLater(account);
        // Opening All Mail is a good moment to look for changes made elsewhere.
        // The check itself loads All Mail again, so at most every 30 seconds.
        if (Date.now() - (account.checkedAt ?? 0) > 30000) {
          controller.debounce(`check:${account.key}`, 2000, () => controller.checkChanges(account).catch(console.error));
        }
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
    // Saved searches do not change what the index holds.
    if (folder?.getFlag(Flags.Virtual)) {
      return;
    }
    if (this.accountFor(folder) || this.detectAccounts().some(a => a.server == folder?.server)) {
      this.debounce("rebuild", 1000, () => this.rebuild(false));
    }
  },

  // ---- search term -----------------------------------------------------------

  /** What the search criterion "Folder (All Mail Buddy)" does, see lib/searchTerm.sys.mjs. */
  searchTermImpl() {
    const Op = Ci.nsMsgSearchOp;
    const Scope = Ci.nsMsgSearchScope;
    return {
      name: () => `${this.config.columnNames?.folder || "Folder"} (All Mail Buddy)`,
      // The local message list knows the folder; a search on the server does not.
      available: scope => scope == Scope.offlineMail || scope == Scope.onlineManual,
      operators: () => [Op.Is, Op.Isnt, Op.Contains, Op.DoesntContain],
      match: (hdr, value, op) => {
        if (this.config.diagnostics) {
          const start = preciseNow();
          if (!this.diag.matches) {
            this.diag.matchStart = start;
          }
          this.diag.matches++;
          try {
            return this.matchTerm(hdr, value, op);
          } finally {
            this.diag.matchMs += preciseNow() - start;
          }
        }
        return this.matchTerm(hdr, value, op);
      },
    };
  },

  matchTerm(hdr, value, op) {
    const Op = Ci.nsMsgSearchOp;
    const { text, status } = this.searchInfo(hdr);
    const wanted = value.trim().toLowerCase();
    const exact = op == Op.Is || op == Op.Isnt;
    const hit = exact ? text.toLowerCase() == wanted || status == wanted : text.toLowerCase().includes(wanted);
    return op == Op.Is || op == Op.Contains ? hit : !hit;
  },

  /** Folder column text and match status of a message, for the search term. */
  searchInfo(hdr) {
    const info = this.started ? this.matchInfo(hdr) : null;
    // A sync keeps the index consistent; while indexing it is incomplete.
    if (!info || info.account.state == "indexing" || info.account.state == "error") {
      return { text: "", status: "" };
    }
    return { text: info.text, status: info.status };
  },

  /**
   * Shows a saved search with every message without a folder. It is created
   * once per account, next to All Mail, and is a local folder only.
   */
  openNoFolderSearch() {
    const name = `${this.config.columnNames?.noFolder || "No folder"} (All Mail Buddy)`;
    let shown = null;
    for (const account of this.accounts.values()) {
      const folder =
        account.root.subFolders.find(f => f.getFlag(Flags.Virtual) && f.getStringProperty(SEARCH_MARK) == "nofolder") ??
        this.createNoFolderSearch(account, name);
      const count = account.coverage?.nofolder ?? 0;
      if (!shown || count > shown.count) {
        shown = { folder, count };
      }
    }
    if (shown) {
      MailUtils.displayFolderIn3Pane(shown.folder.URI);
    }
    return !!shown;
  },

  createNoFolderSearch(account, name) {
    const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(Ci.nsIMsgSearchSession);
    const term = session.createTerm();
    const value = term.value;
    value.attrib = Ci.nsMsgSearchAttrib.Custom;
    value.str = "nofolder";
    term.attrib = Ci.nsMsgSearchAttrib.Custom;
    term.customId = searchTerm.SEARCH_TERM_ID;
    term.op = Ci.nsMsgSearchOp.Is;
    term.value = value;
    term.booleanAnd = true;
    const folder = VirtualFolderHelper.createNewVirtualFolder(name, account.root, [account.allMail], [term], false).virtualFolder;
    folder.setStringProperty(SEARCH_MARK, "nofolder");
    return folder;
  },

  // ---- columns -------------------------------------------------------------

  /** Real folder of a message shown in All Mail or a label folder, else "". */
  locationText(hdr) {
    return this.matchInfo(hdr)?.text ?? "";
  },

  /** Folder column text and match status of a message in All Mail or a label folder, else null. */
  matchInfo(hdr) {
    const account = this.accountFor(hdr.folder);
    const uri = hdr.folder.URI;
    const kind = account && (uri == account.allMailURI ? "allmail" : account.index.folders.get(uri)?.kind);
    if (kind != "allmail" && kind != "label") {
      return null;
    }
    const result = account.index.resolve(this.entryOf(hdr));
    let text = result.location;
    if ((account.state != "ready" && !result.location) || (result.status == "nofolder" && !account.fullySynced)) {
      text = "…";
    } else if (result.status == "nofolder") {
      text = this.config.columnNames?.noFolder || "No folder";
    } else if (result.status == "missing") {
      text = "?";
    }
    return { account, text, status: result.status };
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
      console.warn("All Mail Buddy: could not initialize columns", e);
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
    this.perform(win, command, hdrs, args[0]).catch(e => this.failed(e));
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
    this.perform(win, command, hdrs, target).catch(e => this.failed(e));
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
    this.perform(win, command, hdrs, null, { confirm: false }).catch(e => this.failed(e));
  },

  // ---- actions -------------------------------------------------------------

  /**
   * Map every header to the header in its real folder. All Mail headers are
   * resolved through the index, every other header stays as it is.
   *
   * All Mail headers without any real folder come back as orphans.
   *
   * @returns {{groups: Map<nsIMsgFolder, nsIMsgDBHdr[]>, orphans: nsIMsgDBHdr[], failed: number, waiting: number}}
   */
  resolveReal(hdrs) {
    const groups = new Map();
    const orphans = [];
    let failed = 0;
    let waiting = 0;
    for (const hdr of hdrs) {
      let real = hdr;
      if (this.isAllMail(hdr.folder)) {
        const account = this.accountFor(hdr.folder);
        if (this.isOrphan(account, hdr)) {
          orphans.push(hdr);
          continue;
        }
        if (!account.fullySynced && account.index.resolve(this.entryOf(hdr)).status == "nofolder") {
          waiting++;
          continue;
        }
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
    return { groups, orphans, failed, waiting };
  },

  isOrphan(account, hdr) {
    // Only trust "no folder" when every folder was read; otherwise the real copy
    // may sit in a folder the index does not know yet.
    return (
      account.state == "ready" &&
      account.fullySynced &&
      !account.unreadable.size &&
      !(hdr.flags & Ci.nsMsgMessageFlags.IMAPDeleted) &&
      account.index.resolve(this.entryOf(hdr)).status == "nofolder"
    );
  },

  /**
   * Folder an orphan goes to for a command: false when the command files
   * nothing, null when the folder it needs does not exist. Bridge refuses to
   * move out of All Mail, but copying a message into a folder files the one
   * Proton message there, which is a move for a message that has no folder.
   */
  orphanTarget(allMail, command, destFolder) {
    const root = allMail.rootFolder;
    switch (command) {
      case "cmd_deleteMessage":
      case "cmd_shiftDeleteMessage":
        return root.getFolderWithFlags(Flags.Trash);
      case "cmd_moveMessage":
      case "cmd_copyMessage":
        return destFolder;
      case "cmd_archive":
        return this.archiveFolder(root);
      case "cmd_markAsJunk": {
        const settings = allMail.server.spamSettings;
        if (!settings?.manualMark) {
          return false;
        }
        return settings.manualMarkMode == Ci.nsISpamSettings.MANUAL_MARK_MODE_DELETE
          ? root.getFolderWithFlags(Flags.Trash)
          : (this.junkFolder(allMail) ?? null);
      }
    }
    return false;
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

  /** Bridge's archive folder: the one flagged as archive, else "Archive". */
  archiveFolder(root) {
    const flagged = root.getFolderWithFlags(Flags.Archive);
    if (flagged) {
      return flagged;
    }
    try {
      return root.getChildNamed("Archive");
    } catch {
      return null;
    }
  },

  /**
   * Confirms on the server that each copy's UID still holds that message, with
   * IMAP SEARCH per folder. Returns a notice text when it does not. Offline, and
   * for folders with changes made offline, Thunderbird queues actions as usual.
   */
  async verifyOnServer(groups) {
    for (const [folder, list] of groups) {
      // Thunderbird makes up "md5:" IDs for messages without one; those cannot be looked up.
      const checked = list.filter(hdr => !hdr.messageId.startsWith("md5:"));
      if (
        folder.server.type != "imap" ||
        !this.accountFor(folder) ||
        !checked.length ||
        Services.io.offline ||
        folder.getFlag(Flags.OfflineEvents)
      ) {
        continue;
      }
      const name = this.describe(folder).name;
      const confirmed = new Set();
      let broken = false;
      for (let i = 0; i < checked.length; i += SEARCH_CHUNK) {
        const searched = new Set(checked.slice(i, i + SEARCH_CHUNK).map(hdr => hdr.messageId));
        const { hits, ok } = await this.searchOnline(folder, searched);
        if (!ok) {
          return (
            `The server did not answer the check of "${name}". Nothing was changed. Try again, or turn off ` +
            `"${VERIFY_LABEL}" in the add-on settings.`
          );
        }
        for (const hit of hits) {
          confirmed.add(hit.key);
          broken ||= core.hitVerdict(searched, hit.id) == "broken";
        }
      }
      if (checked.some(hdr => !confirmed.has(hdr.messageKey))) {
        if (broken) {
          // A hit whose local header is another message: the local list is wrong.
          const repairing = this.repairInBackground(folder);
          return (
            `In "${name}" Thunderbird's list puts a selected message under a number that holds another message ` +
            "on the server, so the list is out of date. Nothing was changed. " +
            (repairing
              ? "The folder is being repaired; try again when it shows its messages again."
              : "Repair the folder (right-click, Properties, Repair Folder) and try again.")
          );
        }
        this.refreshInBackground(folder);
        return (
          `"${name}" changed on the server since Thunderbird last loaded it, for example because a selected ` +
          "message was moved or deleted in another app. Nothing was changed. The folder is being loaded again; " +
          "try again in a moment."
        );
      }
    }
    return "";
  },

  refreshInBackground(folder) {
    const account = this.accountFor(folder);
    this.updateFolder(folder)
      .then(ok => {
        if (ok && account) {
          this.markSynced(folder);
          return this.scanFolder(account, folder);
        }
        return null;
      })
      .catch(console.error);
  },

  /** Repairs a folder whose list was found wrong, at most once a day and not during other repairs. */
  repairInBackground(folder) {
    const account = this.accountFor(folder);
    const key = account?.server.key;
    const state = this.checkState();
    const now = Date.now();
    if (
      !account ||
      this.serverChecks.has(key) ||
      !this.rebuildFolderSummary() ||
      folder.locked ||
      folder.getFlag(Flags.OfflineEvents) ||
      core.repairedRecently(state.repaired[folder.URI], now)
    ) {
      return false;
    }
    state.repaired[folder.URI] = now;
    this.saveCheckState(state);
    this.serverChecks.add(key);
    this.repairing.add(key);
    this.repairFolder(folder)
      .then(loaded => loaded && this.scanFolder(account, folder))
      .catch(console.error)
      .finally(() => {
        this.serverChecks.delete(key);
        this.repairing.delete(key);
      });
    return true;
  },

  selectedKey(win) {
    try {
      return win.gDBView?.hdrForFirstSelectedMessage?.messageKey ?? win.gMessage?.messageKey ?? null;
    } catch {
      return null;
    }
  },

  /** One action per window at a time: the server check makes actions take a moment. */
  async perform(win, command, hdrs, destFolder, options) {
    if (win.allMailPlusBusy) {
      this.notice("The previous action is still being checked on the server. Nothing else was changed.");
      return;
    }
    win.allMailPlusBusy = true;
    try {
      await this.performChecked(win, command, hdrs, destFolder, options);
    } finally {
      win.allMailPlusBusy = false;
    }
  },

  performChecked(win, command, hdrs, destFolder, options) {
    return this.timed(`${command} on ${hdrs.length} messages`, () =>
      this.runAction(win, command, hdrs, destFolder, options)
    );
  },

  async runAction(win, command, hdrs, destFolder, { confirm = true } = {}) {
    const { groups, orphans, failed, waiting } = this.resolveReal(hdrs);
    if (waiting) {
      this.notice(
        `${waiting} of ${hdrs.length} selected messages show no folder yet, but not every folder has been loaded ` +
          "from the server since Thunderbird started. Nothing was changed; try again in a minute."
      );
      return;
    }
    if (failed) {
      this.notice(
        `${failed} of ${hdrs.length} selected messages could not be matched to exactly one real folder. ` +
          "Nothing was changed. The folders involved are being synced again, so try again in a few seconds, " +
          "or use the real folder."
      );
      return;
    }
    if (command == "cmd_moveMessage" || command == "cmd_copyMessage") {
      if (this.isAllMail(destFolder)) {
        this.notice("Messages cannot be moved or copied into All Mail; it already shows every message.");
        return;
      }
      if (this.accountFor(destFolder) && this.describe(destFolder).kind == "container") {
        this.notice(`"${destFolder.localizedName}" only holds other folders. Pick a folder inside it.`);
        return;
      }
    }
    if (command == "cmd_archive") {
      const roots = [...groups.keys(), ...orphans.map(hdr => hdr.folder)]
        .filter(f => this.accountFor(f))
        .map(f => f.rootFolder);
      if (roots.some(r => !this.archiveFolder(r))) {
        this.notice("The account has no Archive folder. Nothing was changed.");
        return;
      }
    }
    const orphanCopies = [];
    for (const [allMail, list] of this.byFolder(orphans)) {
      const target = this.orphanTarget(allMail, command, destFolder);
      if (target === null) {
        this.notice(`${list.length} selected messages have no folder and the folder to file them in is missing. Nothing was changed.`);
        return;
      }
      if (target && target != allMail) {
        orphanCopies.push([allMail, list, target]);
      }
    }
    const selected = this.selectedKey(win);
    if (this.config.verifyOnServer !== false) {
      // Orphans are copied out of All Mail by UID, so All Mail is checked too.
      const problem = await this.timed("check the selection on the server", () =>
        this.verifyOnServer(new Map([...groups, ...this.byFolder(orphans)]))
      );
      if (problem) {
        this.notice(problem);
        return;
      }
      if (win.closed) {
        return;
      }
    }
    const msgWindow = win.top.msgWindow;
    const allMailHdrs = hdrs.filter(hdr => this.isAllMail(hdr.folder));
    const touched = new Set(groups.keys());
    const done = () => this.afterAction(touched);
    const listener = this.copyListener(done);
    let moved = true;

    switch (command) {
      case "cmd_deleteMessage":
      case "cmd_shiftDeleteMessage": {
        // Proton only deletes for good from Trash, so orphans always go there.
        const permanent = command == "cmd_shiftDeleteMessage" && groups.size > 0;
        // Pass a Trash folder when any copy lives there, so its warning shows.
        const folders = [...groups.keys()];
        const folder =
          folders.find(f => f.isSpecialFolder(Flags.Trash, true)) ?? (folders.length == 1 ? folders[0] : win.gFolder);
        // A copy in Trash is deleted for good, so ask even for the row button.
        const inTrash = folders.some(f => f.isSpecialFolder(Flags.Trash, true));
        if ((confirm || inTrash) && win.gDBView && !MailUtils.confirmDelete(permanent, win.gDBView, folder)) {
          return;
        }
        for (const [folder, list] of groups) {
          folder.deleteMessages(list, msgWindow, permanent, false, listener, !permanent);
        }
        break;
      }
      case "cmd_moveMessage":
      case "cmd_copyMessage": {
        const kind = this.accountFor(destFolder) ? this.describe(destFolder).kind : "real";
        let anyMove = false;
        for (const [folder, list] of groups) {
          if (folder != destFolder) {
            // In Proton, copying into another folder of the same account files the one
            // message there, so it is a move; Thunderbird should treat it as one.
            const fromRealFolder = this.accountFor(folder) && this.describe(folder).kind == "real";
            const isMove =
              kind != "label" &&
              (command == "cmd_moveMessage" || (fromRealFolder && this.accountFor(destFolder) === this.accountFor(folder)));
            anyMove ||= isMove;
            MailServices.copy.copyMessages(folder, list, destFolder, isMove, listener, msgWindow, true);
          }
        }
        moved = kind != "label" && (command == "cmd_moveMessage" || anyMove);
        touched.add(destFolder);
        Services.prefs.setStringPref("mail.last_msg_movecopy_target_uri", destFolder.URI);
        Services.prefs.setBoolPref("mail.last_msg_movecopy_was_move", command == "cmd_moveMessage");
        break;
      }
      case "cmd_archive": {
        // Bridge has one Archive folder; Thunderbird's yearly or monthly archive
        // subfolders would become new Proton folders.
        const others = [];
        for (const [folder, list] of groups) {
          if (!this.accountFor(folder)) {
            others.push(...list);
            continue;
          }
          const archive = this.archiveFolder(folder.rootFolder);
          if (folder != archive) {
            MailServices.copy.copyMessages(folder, list, archive, true, listener, msgWindow, true);
            touched.add(archive);
          }
        }
        if (others.length) {
          // Messages of other accounts follow Thunderbird's own archive settings.
          const archiver = new MessageArchiver();
          archiver.msgWindow = msgWindow;
          archiver.oncomplete = done;
          archiver.archiveMessages(others);
        }
        break;
      }
      case "cmd_markAsJunk":
        moved = this.markJunk(groups, allMailHdrs, msgWindow, listener) || orphanCopies.length > 0;
        break;
      case "cmd_markAsNotJunk":
        moved = false;
        this.markNotJunk(groups, allMailHdrs, msgWindow, listener);
        break;
    }
    for (const [allMail, list, target] of orphanCopies) {
      // No undo: undoing an IMAP copy expunges it, which Proton treats as a
      // permanent delete when the copy went to Trash or Spam.
      MailServices.copy.copyMessages(allMail, list, target, false, listener, msgWindow, false);
      touched.add(target);
    }
    // Native code may have prepared a selection jump for a row removal that
    // does not happen now (cmd_moveToFolderAgain does this).
    if (win.dbViewWrapperListener) {
      win.dbViewWrapperListener._nextViewIndexAfterDelete = null;
    }
    // Leave the selection alone when the user moved it while the server was checked.
    if (moved && this.selectedKey(win) == selected) {
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

  afterAction(folders) {
    for (const folder of folders) {
      this.rescanLater(folder);
    }
    // IMAP copies report no new headers, so fetch them to update the columns
    // soon. Loading a folder rescans it. All Mail is not synced here: with tens
    // of thousands of messages that would stall Thunderbird after every action,
    // and the change check picks up its changes.
    for (const folder of folders) {
      if (folder.server.type == "imap") {
        this.debounce(`update:${folder.URI}`, 1500, () => this.updateFolder(folder));
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
          serverCheck: account?.serverCheck ?? null,
          lastServerCheck: this.checkState().last[server.key] ?? 0,
          fullySynced: account?.fullySynced ?? false,
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
        checkServer: async () => {
          // Runs in the background; the status shows its progress.
          for (const account of controller.accounts.values()) {
            controller.checkServer(account).catch(console.error);
          }
        },
        listServerFolders: async () =>
          Promise.all(
            [...controller.accounts.values()].map(async account => ({
              name: account.server.prettyName,
              folders: await controller.serverFolders(account),
            }))
          ),
        openNoFolderSearch: async () => controller.openNoFolderSearch(),
        repairDifferingFolders: async (key, kind) => controller.repairDifferingFolders(key, kind ?? "missing"),
        showMessage: async uri => {
          const hdr = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
          MailUtils.displayMessageInFolderTab(hdr);
        },
        getDiagnostics: async () => controller.diag.log.slice(),
        clearDiagnostics: async () => {
          controller.diag.log.length = 0;
        },
        listProblems: async () =>
          Promise.all(
            [...controller.accounts.values()].map(async account => ({
              name: account.server.prettyName,
              messages: account.state == "indexing" ? [] : await controller.problems(account),
            }))
          ),
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

