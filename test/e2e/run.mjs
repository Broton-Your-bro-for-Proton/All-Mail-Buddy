// End-to-end test in a real Thunderbird 153 with a scratch profile, driven by Marionette.
// The profile simulates the Proton Mail Bridge folder layout on Local Folders.
// By default it runs the disposable copy from `npm run setup:thunderbird`, never
// an installed Thunderbird.
//
// Usage: node test/e2e/run.mjs [path/to/thunderbird.exe]
// Env:   TB_BINARY, E2E_KEEP_PROFILE=1, E2E_SCREENSHOTS=<dir>

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { binaryFor, FAKESERVER_DIR } from "../../scripts/fetch-thunderbird.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.argv[2] ?? process.env.TB_BINARY ?? binaryFor();
if (!fs.existsSync(binary)) {
  console.error(`Thunderbird not found at ${binary}. Run "npm run setup:thunderbird" first.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(FAKESERVER_DIR, "mailnews", "Imapd.sys.mjs"))) {
  console.error(`Fake IMAP server not found in ${FAKESERVER_DIR}. Run "npm run setup:thunderbird" first.`);
  process.exit(1);
}
const port = 2829;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "allmailplus-e2e-"));
const shots = process.env.E2E_SCREENSHOTS;

// ---- profile ---------------------------------------------------------------

const prefs = {
  "marionette.port": port,
  "xpinstall.signatures.required": false,
  "extensions.experiments.enabled": true,
  "mail.shell.checkDefaultClient": false,
  "mail.provider.suppress_dialog_on_startup": true,
  "mail.spotlight.firstRunDone": true,
  "mail.winsearch.firstRunDone": true,
  "mailnews.start_page.enabled": false,
  "app.update.disabledForTesting": true,
  "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
  "mail.warn_on_delete_from_trash": false,
  "mail.warn_on_shift_delete": false,
  "mail.warn_on_collapsed_thread_operation": false,
  "mail.close_message_window.on_delete": true,
  "mail.accountmanager.accounts": "account1",
  "mail.accountmanager.defaultaccount": "account1",
  "mail.accountmanager.localfoldersserver": "server1",
  "mail.account.account1.server": "server1",
  "mail.account.account1.identities": "id1",
  "mail.identity.id1.useremail": "me@example.org",
  "mail.identity.id1.fullName": "Me",
  "mail.identity.id1.archive_enabled": true,
  "mail.identity.id1.archive_granularity": 0,
  "mail.server.server1.type": "none",
  "mail.server.server1.hostname": "Local Folders",
  "mail.server.server1.userName": "nobody",
  "mail.server.server1.name": "Bridge Simulation",
  "mail.server.server1.directory-rel": "[ProfD]Mail/Local Folders",
  "mail.spam.manualMark": true,
  "mail.spam.manualMarkMode": 0,
};
fs.writeFileSync(
  path.join(profile, "user.js"),
  Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n")
);

let counter = 0;
function message(id, subject) {
  counter++;
  return [
    "From - Mon Jan 05 10:00:00 2026",
    `Message-ID: <${id}@test>`,
    `Date: Mon, 05 Jan 2026 10:${String(counter).padStart(2, "0")}:00 +0000`,
    "From: Alice <alice@example.org>",
    "To: Me <me@example.org>",
    `Subject: ${subject}`,
    "",
    `Body of ${subject}.`,
    "",
    "",
  ].join("\n");
}

const M = {
  invoice: message("invoice", "Invoice October"),
  order: message("order", "Order shipped"),
  hello: message("hello", "Hello there"),
  meeting: message("meeting", "Meeting notes"),
  spam: message("spam", "Cheap offer"),
  twin: message("twin", "Sent to myself"),
  orphan: message("orphan", "Orphan message"),
  orphanmove: message("orphanmove", "Orphan to move"),
  orphanarchive: message("orphanarchive", "Orphan to archive"),
  drag: message("drag", "Drag me"),
  copy: message("copy", "Copy me"),
  label: message("label", "Label me"),
  restore: message("restore", "Not spam"),
  native: message("native", "Native delete"),
  row: message("row", "Row button delete"),
  tab: message("tab", "Delete from message tab"),
  junkstay: message("junkstay", "Junk without move"),
  sized: message("sized", "Size differs"),
};
// Same Message-ID and date, different body: another message, not a copy.
const sizedOther = M.sized.replace("Body of Size differs.", "A longer body that changes the size.");

const layout = {
  "All Mail": Object.values(M).filter(m => m != M.native),
  Inbox: [M.hello, M.meeting, M.spam, M.twin, M.drag, M.label, M.native, M.tab, M.junkstay, sizedOther],
  Sent: [M.twin],
  Spam: [M.restore],
  Trash: [],
  Folders: [],
  "Folders.sbd/Finanzen": [M.invoice, M.row],
  "Folders.sbd/Shops": [M.order, M.copy],
  Labels: [],
  "Labels.sbd/Wichtig": [M.invoice],
};
const mailDir = path.join(profile, "Mail", "Local Folders");
for (const [name, messages] of Object.entries(layout)) {
  const file = path.join(mailDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, messages.join(""));
}

// ---- marionette client -----------------------------------------------------

class Marionette {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.greeting = new Promise(resolve => (this.onGreeting = resolve));
    socket.setEncoding("utf8");
    socket.on("data", chunk => this.receive(chunk));
  }

  receive(chunk) {
    this.buffer += chunk;
    for (;;) {
      const colon = this.buffer.indexOf(":");
      if (colon < 0) {
        return;
      }
      const length = Number(this.buffer.slice(0, colon));
      const body = this.buffer.slice(colon + 1);
      if (Buffer.byteLength(body) < length) {
        return;
      }
      const bytes = Buffer.from(body);
      const json = bytes.subarray(0, length).toString();
      this.buffer = bytes.subarray(length).toString();
      const packet = JSON.parse(json);
      if (!Array.isArray(packet)) {
        this.onGreeting(packet);
        continue;
      }
      const [, id, error, result] = packet;
      const { resolve, reject } = this.pending.get(id);
      this.pending.delete(id);
      error ? reject(new Error(`${error.error}: ${error.message}`)) : resolve(result);
    }
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const json = JSON.stringify([0, id, name, params]);
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async run(fn, ...args) {
    const script = `const [resolve, args] = [arguments[arguments.length - 1], [...arguments].slice(0, -1)];
      (${fn})(...args).then(value => resolve({ ok: true, value }), error => resolve({ ok: false, error: String(error) + "\\n" + error.stack }));`;
    const { value } = await this.send("WebDriver:ExecuteAsyncScript", { script, args, scriptTimeout: 120000 });
    if (!value.ok) {
      throw new Error(value.error);
    }
    return value.value;
  }
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect(port, "127.0.0.1", () => resolve(s));
        s.on("error", reject);
      });
      const client = new Marionette(socket);
      await client.greeting;
      return client;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error("Marionette did not come up");
}

// ---- in-Thunderbird helpers (serialized into the chrome sandbox) ------------

const helpers = `
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { ThreadPaneColumns } = ChromeUtils.importESModule("chrome://messenger/content/ThreadPaneColumns.mjs");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const root = () => MailServices.accounts.getAccount("account1").incomingServer.rootFolder;
  const folder = p => p.split("/").reduce((f, name) => f.getChildNamed(name), root());
  const has = (p, id) => { try { return !!folder(p).msgDatabase.getMsgHdrForMessageID(id + "@test"); } catch { return false; } };
  const hdr = (p, id) => folder(p).msgDatabase.getMsgHdrForMessageID(id + "@test");
  const pane = () => window.document.getElementById("tabmail").currentAbout3Pane;
  async function until(check, what, ms = 15000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await check()) return; } catch {}
      await sleep(100);
    }
    throw new Error("Timed out: " + what);
  }
  async function show(p) {
    const win = pane();
    win.displayFolder(folder(p));
    await until(() => win.gFolder?.URI == folder(p).URI && win.gDBView, "display " + p);
    await sleep(300);
    return win;
  }
  async function select(id) {
    const win = await show("All Mail");
    const index = win.gDBView.findIndexOfMsgHdr(hdr("All Mail", id), true);
    if (index < 0 || index >= win.gDBView.rowCount) throw new Error("row not found: " + id);
    win.threadTree.selectedIndex = index;
    await until(() => win.gDBView.hdrForFirstSelectedMessage?.messageId == id + "@test", "select " + id);
    return win;
  }
  const cell = (column, p, id) => ThreadPaneColumns.getColumn(column).handler.getCellText(hdr(p, id));
  const urlListener = done => ({
    QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
    OnStartRunningUrl() {},
    OnStopRunningUrl() { done(); },
  });
  const imapRoot = () => MailServices.accounts.accounts.find(a => a.incomingServer.type == "imap")?.incomingServer.rootFolder;
  const ifolder = p => { try { return p.split("/").reduce((f, name) => f.getChildNamed(name), imapRoot()); } catch { return null; } };
  const ihdr = (p, id) => { try { return ifolder(p).msgDatabase.getMsgHdrForMessageID(id + "@imap"); } catch { return null; } };
  const icell = id => ThreadPaneColumns.getColumn("allMailPlusLocation").handler.getCellText(ihdr("All Mail", id));
  const amStatus = name => {
    const o = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    Services.obs.notifyObservers(o, "allmailplus-status");
    return JSON.parse(o.data).accounts.find(a => a.name == name);
  };
  async function showImap(p) {
    const win = pane();
    win.displayFolder(ifolder(p));
    await until(() => win.gFolder?.URI == ifolder(p).URI, "display " + p);
    return win;
  }
`;

function chrome(body) {
  return `async function (...args) { ${helpers}\n${body} }`;
}

// ---- tests -------------------------------------------------------------------

const results = [];
async function check(name, client, body, ...args) {
  try {
    await client.run(chrome(body), ...args);
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`);
  }
}

/**
 * Like check, but runs body inside the page of the current tab. Extension
 * pages live in another process, so the body goes there as a frame script.
 */
async function checkPage(name, client, body) {
  const page = `async () => {
    const sleep = ms => new Promise(r => content.setTimeout(r, ms));
    async function until(check, what, ms = 15000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { if (await check()) return; } catch {}
        await sleep(100);
      }
      throw new Error("Timed out: " + what);
    }
    const doc = content.document;
    ${body}
  }`;
  await check(
    name,
    client,
    `
    const browser = window.document.getElementById("tabmail").currentTabInfo.browser;
    const result = new Promise(resolve => {
      const listener = message => {
        browser.messageManager.removeMessageListener("allmailplus-test", listener);
        resolve(message.data);
      };
      browser.messageManager.addMessageListener("allmailplus-test", listener);
    });
    const script = "(" + args[0] + ")().then(() => sendAsyncMessage('allmailplus-test', ''), e => sendAsyncMessage('allmailplus-test', String(e)))";
    browser.messageManager.loadFrameScript("data:," + encodeURIComponent(script), false);
    const error = await Promise.race([result, sleep(60000).then(() => "frame script did not report back")]);
    if (error) throw new Error(error);
    `,
    page
  );
}

async function screenshot(client, name) {
  if (!shots) {
    return;
  }
  fs.mkdirSync(shots, { recursive: true });
  const { value } = await client.send("WebDriver:TakeScreenshot", { full: false });
  fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(value, "base64"));
}

const tb = spawn(binary, ["-profile", profile, "-no-remote", "-marionette", "-remote-allow-system-access"], {
  stdio: "ignore",
  env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
});
let client;
try {
  client = await connect();
  await client.send("WebDriver:NewSession", { capabilities: {} });
  await client.send("WebDriver:SetTimeouts", { script: 300000 });
  await client.send("Marionette:SetContext", { value: "chrome" });
  await client.send("WebDriver:SetWindowRect", { x: 0, y: 0, width: 1500, height: 900 });

  await client.run(
    chrome(`
      await until(() => pane()?.folderPane && root(), "3-pane ready", 60000);
      for (const f of root().descendants) {
        let parsed = false;
        const listener = { QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]), OnStartRunningUrl() {}, OnStopRunningUrl() { parsed = true; } };
        try { f.QueryInterface(Ci.nsIMsgLocalMailFolder).getDatabaseWithReparse(listener, null); parsed = true; } catch {}
        await until(() => parsed || f.msgDatabase, "parse " + f.name);
      }
    `)
  );

  const installed = await client.send("Addon:Install", { path: path.join(root, "src"), temporary: true });
  const addon = installed.value ?? installed.addon ?? installed;
  console.log(`installed ${addon}`);

  await check(
    "command hooks are installed",
    client,
    `
    await until(() => pane().allMailPlusHooked, "hooked", 10000);
    `
  );

  await check(
    "location and labels columns resolve real folders",
    client,
    `
    await until(() => cell("allMailPlusLocation", "All Mail", "invoice") == "Finanzen", "index ready").catch(e => {
      let value;
      try { value = cell("allMailPlusLocation", "All Mail", "invoice"); } catch (err) { value = "threw " + err; }
      throw new Error(e.message + ", got " + JSON.stringify(value));
    });
    const expect = (a, b) => { if (a !== b) throw new Error(JSON.stringify(a) + " != " + JSON.stringify(b)); };
    expect(ThreadPaneColumns.getColumn("allMailPlusLocation").name, "Folder");
    expect(cell("allMailPlusLabels", "All Mail", "invoice"), "Wichtig");
    expect(cell("allMailPlusLocation", "All Mail", "hello"), "Inbox");
    expect(cell("allMailPlusLocation", "All Mail", "twin"), "Inbox, Sent");
    expect(cell("allMailPlusLocation", "All Mail", "orphan"), "No folder");
    expect(cell("allMailPlusLocation", "Folders/Finanzen", "invoice"), "");
    expect(cell("allMailPlusLabels", "Folders/Finanzen", "invoice"), "Wichtig");
    expect(cell("allMailPlusLocation", "Labels/Wichtig", "invoice"), "Finanzen");
    `
  );

  await check(
    "status explains unmatched messages",
    client,
    `
    const status = () => {
      const o = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
      Services.obs.notifyObservers(o, "allmailplus-status");
      return JSON.parse(o.data).accounts[0];
    };
    await until(() => status().coverage?.nofolder == 3, "coverage counts messages without folder");
    const { coverage } = status();
    if (coverage.reasons.size != 1) throw new Error("size reason: " + JSON.stringify(coverage));
    if (!Object.keys(coverage.sizeDeltas).every(d => Number(d) > 0)) throw new Error("size delta: " + JSON.stringify(coverage));
    if (!coverage.examples.some(e => e.subject == "Orphan message")) throw new Error("examples: " + JSON.stringify(coverage.examples));
    `
  );

  await check(
    "toolbar button is shown",
    client,
    `
    await until(() => window.document.documentElement.outerHTML.includes("allmailplus"), "toolbar button");
    `
  );
  await screenshot(client, "toolbar");

  await check(
    "cards view shows the location badge in All Mail",
    client,
    `
    const win = await show("All Mail");
    const index = win.gDBView.findIndexOfMsgHdr(hdr("All Mail", "invoice"), true);
    win.threadTree.scrollToIndex(index);
    await until(() => win.threadTree.getRowAtIndex(index)?.querySelector(".allmailplus-badge")?.textContent == "Finanzen · Wichtig", "badge text");
    `
  );
  await screenshot(client, "cards");

  await check(
    "table view shows the columns in All Mail",
    client,
    `
    Services.prefs.setIntPref("mail.threadpane.listview", 1);
    const win = await show("All Mail");
    await until(() => win.threadPane.columns.find(c => c.id == "allMailPlusLocation")?.hidden === false, "column visible");
    const index = win.gDBView.findIndexOfMsgHdr(hdr("All Mail", "invoice"), true);
    win.threadTree.scrollToIndex(index);
    await until(() => win.threadTree.getRowAtIndex(index)?.querySelector(".allmailpluslocation-column")?.textContent == "Finanzen", "cell text");
    `
  );
  await screenshot(client, "table");

  await check(
    "Delete in All Mail moves the real message to Trash",
    client,
    `
    const win = await select("hello");
    win.commandController.doCommand("cmd_deleteMessage");
    await until(() => has("Trash", "hello") && !has("Inbox", "hello"), "moved to trash");
    if (!has("All Mail", "hello")) throw new Error("All Mail entry was touched");
    await until(() => cell("allMailPlusLocation", "All Mail", "hello") == "Trash", "location updates");
    `
  );

  await check(
    "Move in All Mail moves the real message, Undo restores it",
    client,
    `
    const win = await select("order");
    win.commandController.doCommand("cmd_moveMessage", folder("Folders/Finanzen"));
    await until(() => has("Folders/Finanzen", "order") && !has("Folders/Shops", "order"), "moved");
    await until(() => cell("allMailPlusLocation", "All Mail", "order") == "Finanzen", "location updates");
    window.goDoCommand("cmd_undo");
    await until(() => has("Folders/Shops", "order") && !has("Folders/Finanzen", "order"), "undone");
    `
  );

  await check(
    "Copy in All Mail copies from the real folder",
    client,
    `
    const win = await select("copy");
    win.commandController.doCommand("cmd_copyMessage", folder("Folders/Finanzen"));
    await until(() => has("Folders/Finanzen", "copy") && has("Folders/Shops", "copy"), "copied");
    `
  );

  await check(
    "Move to a label folder applies the label and keeps the folder",
    client,
    `
    const win = await select("label");
    win.commandController.doCommand("cmd_moveMessage", folder("Labels/Wichtig"));
    await until(() => has("Labels/Wichtig", "label") && has("Inbox", "label"), "labeled");
    await until(() => cell("allMailPlusLabels", "All Mail", "label") == "Wichtig", "labels column");
    `
  );

  await check(
    "Archive in All Mail archives the real message",
    client,
    `
    const win = await select("meeting");
    win.commandController.doCommand("cmd_archive");
    await until(() => !has("Inbox", "meeting") && has("Archives", "meeting"), "archived");
    `
  );

  await check(
    "Junk in All Mail moves the real message to Spam",
    client,
    `
    const win = await select("spam");
    win.commandController.doCommand("cmd_markAsJunk");
    await until(() => has("Spam", "spam") && !has("Inbox", "spam"), "moved to spam").catch(e => {
      const where = root().descendants.filter(f => has(f.URI.split("Local%20Folders/")[1].split("/").map(decodeURIComponent).join("/"), "spam")).map(f => f.name);
      throw new Error(e.message + " in " + where + ", spamFolderURI " + root().server.spamSettings.spamFolderURI + ", score " + hdr("All Mail", "spam").getStringProperty("junkscore"));
    });
    if (hdr("All Mail", "spam").getStringProperty("junkscore") != "100") throw new Error("All Mail junk score");
    `
  );

  await check(
    "Not junk in All Mail moves the real message to the Inbox",
    client,
    `
    const win = await select("restore");
    win.commandController.doCommand("cmd_markAsNotJunk");
    await until(() => has("Inbox", "restore") && !has("Spam", "restore"), "moved to inbox");
    `
  );

  await check(
    "Drag and drop from All Mail moves the real message",
    client,
    `
    const win = await show("All Mail");
    const msg = hdr("All Mail", "drag");
    const target = win.folderPane.getRowForFolder(folder("Folders/Finanzen"));
    await win.folderPane._onDrop({
      target,
      preventDefault() {},
      dataTransfer: {
        dropEffect: "move",
        mozItemCount: 1,
        mozTypesAt: () => ["text/x-moz-message"],
        mozGetDataAt: () => msg.folder.getUriForMsg(msg),
      },
    });
    await until(() => has("Folders/Finanzen", "drag") && !has("Inbox", "drag"), "dropped");
    `
  );

  await check(
    "Row delete button in All Mail deletes the real message",
    client,
    `
    const win = await show("All Mail");
    const index = win.gDBView.findIndexOfMsgHdr(hdr("All Mail", "row"), true);
    win.threadPane.treeTable.dispatchEvent(new win.CustomEvent("request-delete", { bubbles: true, detail: { index } }));
    await until(() => has("Trash", "row") && !has("Folders/Finanzen", "row"), "row delete");
    if (!has("All Mail", "row")) throw new Error("All Mail entry was touched");
    `
  );

  await check(
    "Ambiguous messages are refused and nothing changes",
    client,
    `
    const win = await select("twin");
    win.commandController.doCommand("cmd_deleteMessage");
    await sleep(1500);
    if (!has("Inbox", "twin") || !has("Sent", "twin") || has("Trash", "twin") || !has("All Mail", "twin")) {
      throw new Error("ambiguous message was changed");
    }
    `
  );

  await check(
    "Messages without a folder are filed by copying them out of All Mail",
    client,
    `
    let win = await select("orphan");
    const undoItems = window.messenger.transactionManager.numberOfUndoItems;
    win.commandController.doCommand("cmd_deleteMessage");
    await until(() => has("Trash", "orphan"), "orphan copied to Trash");
    // Undo would expunge the Trash copy, which Proton deletes for good.
    if (window.messenger.transactionManager.numberOfUndoItems != undoItems) throw new Error("orphan copy is undoable");
    await until(() => cell("allMailPlusLocation", "All Mail", "orphan") == "Trash", "orphan location");
    win = await select("orphanmove");
    win.commandController.doCommand("cmd_moveMessage", folder("Folders/Shops"));
    await until(() => has("Folders/Shops", "orphanmove"), "orphan copied to Shops");
    win = await select("orphanarchive");
    win.commandController.doCommand("cmd_archive");
    await until(() => has("Archives", "orphanarchive"), "orphan copied to Archives");
    for (const id of ["orphan", "orphanmove", "orphanarchive"]) {
      if (!has("All Mail", id)) throw new Error("All Mail entry was removed: " + id);
    }
    `
  );

  await check(
    "Delete in a message tab acts on the real message and closes the tab",
    client,
    `
    const tabmail = window.document.getElementById("tabmail");
    const msg = hdr("All Mail", "tab");
    tabmail.openTab("mailMessageTab", { messageURI: msg.folder.getUriForMsg(msg), background: false });
    const tab = tabmail.currentTabInfo;
    await until(() => tab.chromeBrowser?.contentWindow?.gMessage?.messageId == "tab@test", "message tab");
    const win = tab.chromeBrowser.contentWindow;
    await until(() => win.allMailPlusHooked, "message tab hooked");
    win.commandController.doCommand("cmd_deleteMessage");
    await until(() => has("Trash", "tab") && !has("Inbox", "tab"), "deleted");
    await until(() => !tabmail.tabInfo.includes(tab), "tab closed");
    if (!has("All Mail", "tab")) throw new Error("All Mail entry was touched");
    `
  );

  await check(
    "Junk without the move setting marks the real message and keeps the selection",
    client,
    `
    Services.prefs.setBoolPref("mail.spam.manualMark", false);
    try {
      const win = await select("junkstay");
      const before = win.threadTree.selectedIndex;
      win.commandController.doCommand("cmd_markAsJunk");
      await until(() => hdr("Inbox", "junkstay").getStringProperty("junkscore") == "100", "real score");
      await sleep(500);
      if (!has("Inbox", "junkstay")) throw new Error("message moved");
      if (win.threadTree.selectedIndex != before) throw new Error("selection moved");
    } finally {
      Services.prefs.setBoolPref("mail.spam.manualMark", true);
    }
    `
  );

  await check(
    "A candidate with another size is not treated as the real copy",
    client,
    `
    if (cell("allMailPlusLocation", "All Mail", "sized") != "?") throw new Error("matched a different message");
    const win = await select("sized");
    win.commandController.doCommand("cmd_deleteMessage");
    await sleep(1000);
    if (!has("Inbox", "sized") || has("Trash", "sized")) throw new Error("different message was deleted");
    `
  );

  await check(
    "Other folders keep native behavior",
    client,
    `
    const win = await show("Inbox");
    const index = win.gDBView.findIndexOfMsgHdr(hdr("Inbox", "native"), true);
    win.threadTree.selectedIndex = index;
    await until(() => win.gDBView.hdrForFirstSelectedMessage?.messageId == "native@test", "select native");
    win.commandController.doCommand("cmd_deleteMessage");
    await until(() => has("Trash", "native") && !has("Inbox", "native"), "native delete");
    `
  );

  await check(
    "settings page loads without script errors",
    client,
    `
    const url = WebExtensionPolicy.getByID(args[0]).getURL("options/options.html");
    window.document.getElementById("tabmail").openTab("contentTab", { url });
    await sleep(2500);
    const errors = Services.console.getMessageArray()
      .filter(m => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
      .filter(m => m.sourceName?.includes("/options/"))
      .map(m => m.errorMessage);
    if (errors.length) throw new Error(errors.join("; "));
    `,
    addon
  );

  await checkPage(
    "settings page shows the diagnosis and every affected message as tables",
    client,
    `
    await until(() => doc.querySelector("#diagnosis table"), "diagnosis table");
    const diagnosis = doc.getElementById("diagnosis").textContent;
    if (!diagnosis.includes("Ambiguous") || !diagnosis.includes("Size differs")) throw new Error("diagnosis: " + diagnosis);
    doc.getElementById("showProblems").click();
    await until(() => doc.querySelectorAll("#problems tbody tr").length >= 2, "problem rows");
    const rows = [...doc.querySelectorAll("#problems tbody tr")].map(r => r.textContent);
    if (!rows.some(r => r.includes("Sent to myself") && r.includes("Ambiguous"))) throw new Error("rows: " + rows.join(" | "));
    if (!rows.some(r => r.includes("Size differs") && r.includes("Copy differs") && r.includes("Inbox"))) throw new Error("rows: " + rows.join(" | "));
    doc.getElementById("problemFilter").value = "ambiguous";
    doc.getElementById("problemFilter").dispatchEvent(new Event("change"));
    const filtered = [...doc.querySelectorAll("#problems tbody tr")].map(r => r.textContent);
    if (!filtered.length || filtered.length >= rows.length || !filtered.every(r => r.includes("Ambiguous"))) {
      throw new Error("filter: " + filtered.join(" | "));
    }
    doc.getElementById("listFolders").click();
    await until(() => doc.getElementById("serverFolders").textContent.includes("every folder"), "server folder list");
    doc.getElementById("serverCheck").scrollIntoView();
    `
  );
  await screenshot(client, "options");

  // ---- IMAP ------------------------------------------------------------------
  // Thunderbird's own fake IMAP server (from its test suite) runs inside the
  // test Thunderbird and serves the Bridge layout over real IMAP.

  await check(
    "IMAP: a fake Bridge server is set up and synced",
    client,
    `
    const tabmail = window.document.getElementById("tabmail");
    while (tabmail.tabInfo.length > 1) tabmail.closeTab(tabmail.tabInfo.at(-1));
    Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsISubstitutingProtocolHandler)
      .setSubstitution("testing-common", Services.io.newURI(args[0]));
    const { nsMailServer } = ChromeUtils.importESModule("resource://testing-common/mailnews/Maild.sys.mjs");
    const { ImapDaemon, ImapMessage, IMAP_RFC3501_handler, mixinExtension } =
      ChromeUtils.importESModule("resource://testing-common/mailnews/Imapd.sys.mjs");
    const daemon = new ImapDaemon();
    daemon.inbox.subscribed = true;
    const boxes = ["All Mail", "Folders", "Folders/Shops", "Folders/Finanzen", "Folders/Hidden", "Labels", "Labels/Wichtig", "Trash", "Spam", "Sent"];
    for (const name of boxes) {
      daemon.createMailbox(name, { subscribed: name != "Folders/Hidden", uidvalidity: daemon.uidvalidity++ });
    }
    const literal = (id, subject) => [
      "Message-ID: <" + id + "@imap>",
      "Date: Tue, 06 Jan 2026 10:00:00 +0000",
      "From: Bob <bob@example.org>",
      "To: Me <me@example.org>",
      "Subject: " + subject,
      "",
      "Body of " + subject + ".",
      "",
    ].join("\\r\\n");
    const uri = text => "data:text/plain," + encodeURIComponent(text);
    const put = (box, id, subject) => {
      const mailbox = daemon.getMailbox(box);
      const message = new ImapMessage(uri(literal(id, subject)), mailbox.uidnext++, []);
      mailbox.addMessage(message);
      return message;
    };
    const idOf = message =>
      (decodeURIComponent(message._URI.slice(message._URI.indexOf(",") + 1)).match(/^Message-ID:\\s*<([^>]+)>/im) ?? [])[1] ?? "";
    // The fake server only answers SEARCH UNDELETED; Bridge also answers HEADER searches.
    const headerSearch = {
      SEARCH(searchArgs, uid) {
        const wanted = [];
        const walk = list => {
          for (let i = 0; i < list.length; i++) {
            if (Array.isArray(list[i])) {
              walk(list[i]);
            } else if (String(list[i]).toUpperCase() == "HEADER" && String(list[i + 1]).toLowerCase() == "message-id") {
              wanted.push(String(list[i + 2]).toLowerCase());
              i += 2;
            }
          }
        };
        walk(searchArgs);
        window.allMailPlusTest.searches++;
        const messages = this._selectedMailbox._messages;
        const hits = messages.filter(m => !m.flags.includes("\\\\Deleted") &&
          (!wanted.length || wanted.some(w => idOf(m).toLowerCase().includes(w))));
        return "* SEARCH" + hits.map(m => " " + (uid ? m.uid : messages.indexOf(m) + 1)).join("") + "\\0OK SEARCH COMPLETED";
      },
    };
    const server = new nsMailServer(d => {
      const handler = new IMAP_RFC3501_handler(d);
      mixinExtension(handler, headerSearch);
      return handler;
    }, daemon);
    server.start();
    window.allMailPlusTest = { daemon, server, put, idOf, uri, literal, ImapMessage, searches: 0 };
    for (const [box, id, subject] of [["Folders/Shops", "shop", "Shop order"], ["Folders/Finanzen", "bill", "Bill"], ["Folders/Shops", "stale", "Old message"]]) {
      put(box, id, subject);
      put("All Mail", id, subject);
    }

    const incoming = MailServices.accounts.createIncomingServer("user", "localhost", "imap");
    incoming.port = server.port;
    incoming.password = "password";
    incoming.prettyName = "Bridge IMAP";
    const account = MailServices.accounts.createAccount();
    account.incomingServer = incoming;
    const identity = MailServices.accounts.createIdentity();
    identity.email = "me@example.org";
    account.addIdentity(identity);
    await new Promise(resolve => MailServices.imap.discoverAllFolders(incoming.rootFolder, urlListener(resolve), null));
    await until(() => ifolder("All Mail") && ifolder("Folders/Finanzen"), "IMAP folders discovered", 30000);
    if (ifolder("Folders/Hidden")) throw new Error("the unsubscribed folder was discovered");
    for (const p of ["Folders/Shops", "Folders/Finanzen", "All Mail"]) {
      await showImap(p);
    }
    await until(() => ihdr("All Mail", "stale") && ihdr("Folders/Shops", "stale"), "folders synced", 90000).catch(e => {
      const count = p => { try { return ifolder(p).getTotalMessages(false); } catch (err) { return String(err); } };
      throw new Error(e.message + " " + JSON.stringify([!!ihdr("All Mail", "stale"), !!ihdr("Folders/Shops", "stale"), count("All Mail"), count("Folders/Shops")]));
    });
    `,
    pathToFileURL(FAKESERVER_DIR).href + "/"
  );

  await check(
    "IMAP: the Folder column resolves real folders",
    client,
    `
    await until(() => icell("shop") == "Shops", "shop resolves", 30000).catch(e => {
      let got;
      try { got = icell("shop"); } catch (err) { got = String(err); }
      throw new Error(e.message + ", got " + got);
    });
    if (icell("bill") != "Finanzen") throw new Error("bill: " + icell("bill"));
    `
  );

  await check(
    "IMAP: opening All Mail syncs the folders that changed on the server",
    client,
    `
    await until(() => !amStatus("Bridge IMAP")?.serverCheck?.running, "no server check running", 90000);
    // Keep the daily server check out of this test.
    Services.prefs.setStringPref("extensions.allmailplus.serverCheck",
      JSON.stringify({ last: { [imapRoot().server.key]: Date.now() }, repaired: {} }));
    const t = window.allMailPlusTest;
    t.put("Folders/Finanzen", "new", "New bill");
    t.put("All Mail", "new", "New bill");
    await showImap("Folders/Shops");
    await showImap("All Mail");
    await until(() => ihdr("All Mail", "new") && icell("new") == "Finanzen", "new message resolves", 45000);
    `
  );

  await check(
    "IMAP: the daily server check repairs only the folder whose local list is wrong",
    client,
    `
    const name = "Bridge IMAP";
    await until(() => !amStatus(name)?.serverCheck?.running, "no server check running", 90000);
    const t = window.allMailPlusTest;
    // Bridge reuses the UID of "stale" in Shops for another message. The UID set
    // and counts stay the same, so Thunderbird keeps its old header.
    const shops = t.daemon.getMailbox("Folders/Shops");
    const index = shops._messages.findIndex(m => t.idOf(m) == "stale@imap");
    shops._messages[index] = new t.ImapMessage(t.uri(t.literal("fresh", "Fresh message")), shops._messages[index].uid, []);
    const allMail = t.daemon.getMailbox("All Mail");
    allMail._messages.splice(allMail._messages.findIndex(m => t.idOf(m) == "stale@imap"), 1);
    t.put("All Mail", "fresh", "Fresh message");
    Services.prefs.clearUserPref("extensions.allmailplus.serverCheck");
    const since = Date.now();
    const searches = t.searches;
    await showImap("Folders/Shops");
    await showImap("All Mail");
    await until(() => ihdr("All Mail", "fresh"), "fresh in All Mail", 30000);
    if (ihdr("Folders/Shops", "fresh")) throw new Error("Thunderbird noticed the change by itself, the scenario is not reproduced");
    await until(() => {
      const c = amStatus(name)?.serverCheck;
      return c && c.auto && c.startedAt >= since && !c.running;
    }, "daily check ran", 120000).catch(e => {
      throw new Error(e.message + " " + JSON.stringify(amStatus(name)) + " fresh=" + icell("fresh") + " shopsFresh=" + !!ihdr("Folders/Shops", "fresh"));
    });
    const report = amStatus(name).serverCheck;
    if (report.error) throw new Error(report.error);
    if (report.repaired.join() != "Shops") throw new Error("repaired: " + JSON.stringify(report));
    if (t.searches == searches) throw new Error("no IMAP search was sent");
    await until(() => icell("fresh") == "Shops", "fresh resolves after the repair", 60000).catch(e => {
      const ids = [...ifolder("Folders/Shops").messages].map(h => h.messageKey + ":" + h.messageId + ":" + h.flags);
      throw new Error(e.message + ", got " + icell("fresh") + " shops=" + ids.join(",") + " report=" + JSON.stringify(report));
    });
    `
  );

  await check(
    "IMAP: open the settings page",
    client,
    `
    const url = WebExtensionPolicy.getByID(args[0]).getURL("options/options.html");
    window.document.getElementById("tabmail").openTab("contentTab", { url });
    await sleep(2000);
    `,
    addon
  );

  await checkPage(
    "IMAP: the settings page lists unsubscribed server folders and checks the server on demand",
    client,
    `
    doc.getElementById("listFolders").click();
    await until(() => doc.getElementById("serverFolders").textContent.includes("Folders/Hidden"), "hidden folder listed", 30000);
    const rows = [...doc.querySelectorAll("#serverFolders tbody tr")].map(r => r.textContent);
    if (rows.length != 1 || !rows[0].includes("no")) throw new Error("rows: " + rows.join(" | "));
    const state = () =>
      [...doc.querySelectorAll("#serverCheck tbody tr")].find(r => r.cells[0].textContent == "Bridge IMAP")?.cells[2].textContent ?? "";
    const button = doc.getElementById("checkServer");
    await until(() => !button.disabled, "no check running", 90000);
    const box = button.getBoundingClientRect();
    if (!box.width || content.getComputedStyle(button).visibility != "visible") throw new Error("check button is not visible");
    button.click();
    await until(() => state().startsWith("running"), "manual check started", 10000).catch(() => {});
    await until(() => state().startsWith("run done"), "manual check done", 90000).catch(e => {
      throw new Error(e.message + ", state " + state());
    });
    if (state() != "run done") throw new Error("state: " + state());
    doc.getElementById("serverCheck").scrollIntoView();
    `
  );
  await screenshot(client, "options-imap");

  if (results.some(r => !r.ok)) {
    const log = await client.run(
      chrome(`
        return Services.console.getMessageArray()
          .map(m => m.message ?? String(m))
          .filter(t => !t.startsWith("[JavaScript Warning") && !t.includes("CSS"))
          .slice(-25);
      `)
    );
    console.log(["console:", ...log].join("\n  "));
  }

} catch (e) {
  console.log(`FAIL harness\n     ${e.stack}`);
  results.push({ name: "harness", ok: false });
} finally {
  try {
    await client?.send("Marionette:Quit", { flags: ["eForceQuit"] });
  } catch {}
  setTimeout(() => tb.kill(), 3000).unref();
  await new Promise(r => tb.once("exit", r));
  if (!process.env.E2E_KEEP_PROFILE) {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } else {
    console.log(`profile kept at ${profile}`);
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
