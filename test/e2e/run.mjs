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
import { fileURLToPath } from "node:url";
import { binaryFor } from "../../scripts/fetch-thunderbird.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.argv[2] ?? process.env.TB_BINARY ?? binaryFor();
if (!fs.existsSync(binary)) {
  console.error(`Thunderbird not found at ${binary}. Run "npm run setup:thunderbird" first.`);
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
    expect(cell("allMailPlusLocation", "All Mail", "orphan"), "?");
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
    await until(() => status().coverage?.reasons?.["no-copy"] >= 1, "coverage with reasons");
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
    const orphan = await select("orphan");
    orphan.commandController.doCommand("cmd_deleteMessage");
    await sleep(1000);
    if (!has("All Mail", "orphan") || has("Trash", "orphan")) throw new Error("orphan was changed");
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
  await screenshot(client, "options");

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
