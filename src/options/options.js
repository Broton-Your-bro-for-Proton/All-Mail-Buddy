"use strict";

const DEFAULTS = {
  syncOnStartup: true,
  checkIntervalMinutes: 5,
  dailyServerCheck: true,
  verifyMode: "permanent",
  diagnostics: false,
  disabledAccounts: [],
};

// Built after the catalog loaded, so they are functions.
const STATES = () => ({
  ready: t("Ready"),
  indexing: t("Reading folders..."),
  syncing: t("Syncing..."),
  pending: t("Waiting"),
  disabled: t("Off"),
  error: t("Error"),
});
const folderCount = n => (n == 1 ? t("1 folder") : t("{count} folders", { count: n }));
const $ = id => document.getElementById(id);

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className;
  return td;
}

function row(...cells) {
  const tr = document.createElement("tr");
  tr.append(...cells.map(c => (c instanceof Node ? c : cell(c))));
  return tr;
}

/** A table with a header row; rows are arrays of texts or cells. */
function table(headers, rows) {
  const t = document.createElement("table");
  const head = document.createElement("thead");
  head.append(row(...headers.map(h => Object.assign(document.createElement("th"), { textContent: h }))));
  const body = document.createElement("tbody");
  body.append(...rows.map(cells => row(...cells)));
  t.append(head, body);
  return t;
}

const PROBLEMS = () => ({
  ambiguous: t("Ambiguous"),
  missing: t("Copy differs"),
  close: t("Probably the same"),
  nofolder: t("No folder"),
});

const REASONS = () => ({
  size: t("size differs"),
  date: t("date differs"),
  "size-date": t("size and date differ"),
});

const day = ms => (ms ? new Date(ms).toLocaleDateString() : "");
const time = ms => (ms ? new Date(ms).toLocaleString() : "");

const topDeltas = (map, unit) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([delta, n]) => `${delta > 0 ? "+" : ""}${unit(delta)} (${n}x)`)
    .join(", ");

/** A cell with text and buttons; actions are [label, handler]. */
function actionCell(text, actions = []) {
  const td = cell(text);
  if (actions.length) {
    const bar = document.createElement("div");
    bar.className = "actions";
    for (const [label, handler, role, title] of actions) {
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        className: "btn btn-default",
        textContent: label,
      });
      if (role) {
        button.dataset.role = role;
      }
      if (title) {
        button.title = title;
      }
      button.addEventListener("click", () => run(button, handler));
      bar.append(button);
    }
    td.append(bar);
  }
  return td;
}

async function showOnly(problem) {
  await showProblems();
  $("problemFilter").value = problem;
  renderProblems();
  $("problemCount").scrollIntoView();
}

async function repairDiffering(account, kind = "missing") {
  const { repaired, skipped, errors, unfixable, busy, before, after } = await browser.allMailPlus.repairDifferingFolders(
    account.key,
    kind
  );
  if (busy) {
    pageNotice = t("Nothing was repaired: {reason} Try again in a moment.", { reason: busy });
    return;
  }
  pageNotice = [
    t("Repaired: {list}.", { list: repaired.join(", ") || t("none") }),
    repaired.length ? t("Messages with this problem: {before} before, {after} now.", { before, after }) : "",
    skipped.length ? t("Skipped: {list}.", { list: skipped.join(", ") }) : "",
    errors.length ? t("Problems: {list}.", { list: errors.join("; ") }) : "",
    unfixable.length
      ? kind == "ambiguous"
        ? t("{list} still list the message after the repair, so Proton really keeps it more than once; these folders are not offered for repair again for 30 days.", { list: unfixable.join(", ") })
        : t("In {list} the copies still differ after the repair, so they really differ; these folders are not offered for repair again for 30 days.", { list: unfixable.join(", ") })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Rows of the problem table: [problem, count, what it means, what you can do]. */
function problemRows(account) {
  const { coverage, unreadable } = account;
  const rows = [];
  if (coverage?.ambiguous) {
    const self = coverage.ambiguousSelf ?? 0;
    const folders = Math.min(coverage.ambiguousFolders ?? 0, 25);
    rows.push([
      PROBLEMS().ambiguous,
      coverage.ambiguous,
      t("Each of these All Mail messages matches a copy in more than one real folder, with the same Message-ID, size and date. Proton keeps a message in a single folder, so either Thunderbird's list of one of these folders is out of date, or Proton really holds two identical messages.") +
        (self
          ? " " + t("{count} of them have a copy in Sent, so they are most likely messages you sent to yourself: Proton keeps those once in Sent and once in the folder they arrived in, and a repair cannot change that.", { count: self })
          : ""),
      actionCell(
        t("The add-on syncs the folders involved again by itself. If that does not help, repair the folders that hold these copies: Thunderbird then loads their message lists from the server again, which also downloads their offline copies again if you keep any. Messages that stay ambiguous cannot be told apart, so the add-on refuses delete, move and the other actions on them to avoid acting on the wrong copy; handle them in their real folder, which the list shows.") +
          (coverage.ambiguousUnfixable
            ? " " + t("In {folders} a repair did not help, so Proton really keeps those messages more than once.", { folders: folderCount(coverage.ambiguousUnfixable) })
            : ""),
        [
          ...(folders
            ? [
                [
                  t("Repair {folders}", { folders: folderCount(folders) }),
                  () => repairDiffering(account, "ambiguous"),
                  "",
                  t("Folders: {list}", { list: (coverage.ambiguousNames ?? []).join(", ") }),
                ],
              ]
            : []),
          [t("Show them"), () => showOnly("ambiguous")],
        ]
      ),
    ]);
  }
  if (coverage?.missing) {
    const reasons = Object.entries(coverage.reasons)
      .map(([key, n]) => `${n} ${REASONS()[key] ?? key}`)
      .join(", ");
    const deltas = [
      Object.keys(coverage.sizeDeltas).length &&
        t("The stored size is off by {list}.", { list: topDeltas(coverage.sizeDeltas, n => t("{count} bytes", { count: n })) }),
      Object.keys(coverage.dateDeltas).length &&
        t("The date is off by {list}.", { list: topDeltas(coverage.dateDeltas, n => t("{count} seconds", { count: n })) }),
    ].filter(Boolean);
    const folders = Math.min(coverage.differingFolders ?? 0, 25);
    const unfixable = coverage.unfixableFolders
      ? " " + t("In {folders} a repair did not help, so those copies really differ, for example two different messages that share a Message-ID.", { folders: folderCount(coverage.unfixableFolders) })
      : "";
    rows.push([
      PROBLEMS().missing,
      coverage.missing,
      [
        t("A real folder holds a message with the same Message-ID, but Thunderbird stored it with another size or date than the All Mail copy ({reasons}).", { reasons }),
        ...deltas,
        t("Often one of the two local copies is outdated because the message changed on the server. To be safe, the add-on treats them as different messages and refuses actions on them."),
      ].join(" "),
      actionCell(
        t("Repair the folders that hold these copies: Thunderbird then loads their message lists from the server again, which also downloads their offline copies again if you keep any. If the difference stays, the copies really differ or All Mail itself is out of date; handle these messages in their real folder.") +
          unfixable,
        [
          ...(folders
            ? [
                [
                  t("Repair {folders}", { folders: folderCount(folders) }),
                  () => repairDiffering(account),
                  "",
                  t("Folders: {list}", { list: (coverage.differingNames ?? []).join(", ") }),
                ],
              ]
            : []),
          [t("Show them"), () => showOnly("missing")],
        ]
      ),
    ]);
  }
  if (coverage?.close) {
    rows.push([
      PROBLEMS().close,
      coverage.close,
      t('These All Mail messages have no exact copy in a real folder, but one with the same Message-ID and date that is only a few bytes off. Bridge serves some, mostly old, messages slightly differently in different folders, and a repair does not change that. So it is most likely the same message, but this cannot be told for sure; the Folder column shows the folder with a question mark, for example "Trash?".'),
      actionCell(t("Nothing to do. When you delete, move or archive one of them, the add-on asks once before it acts on that copy."), [
        [t("Show them"), () => showOnly("close")],
      ]
      ),
    ]);
  }
  if (coverage?.nofolder) {
    rows.push([
      PROBLEMS().nofolder,
      coverage.nofolder,
      t("No real folder in Thunderbird has a copy of these messages. Either Proton keeps them only in All Mail, without any folder, which happens for example when an email program moved them to a local folder, or Thunderbird's list of the folder that holds them is out of date.") +
        (coverage.fullySynced
          ? ""
          : " " + t('Some folders have not been loaded from the server since Thunderbird started, so this number can still drop; until then the Folder column shows "..." for these messages and actions wait.')),
      actionCell(
        t("Run the server check: it finds the folders whose list is out of date and repairs only those. The messages that remain really have no folder. Delete, move, archive and junk still work on them once every folder could be read: the add-on files the message into the target folder, and delete puts it into Trash. The saved search lists them all so you can handle them together."),
        [
          [t("Check server now"), () => browser.allMailPlus.checkServer(), "checkServer"],
          [t('Open saved search "{name}"', { name: t("No folder") }), () => browser.allMailPlus.openNoFolderSearch()],
        ]
      ),
    ]);
  }
  if (unreadable?.length) {
    rows.push([
      t("Unreadable folders"),
      unreadable.length,
      t("Thunderbird could not open these folders, so their messages are missing from the index: {list}.", { list: unreadable.join(", ") }),
      actionCell(t("Repair them in Thunderbird: right-click the folder, Properties, Repair Folder. Then click Rebuild index above.")),
    ]);
  }
  return rows;
}

function coverageText(coverage) {
  if (!coverage) {
    return "";
  }
  const parts = [t("{count} matched", { count: coverage.unique })];
  if (coverage.ambiguous) {
    parts.push(t("{count} ambiguous", { count: coverage.ambiguous }));
  }
  if (coverage.missing) {
    parts.push(t("{count} copy differs", { count: coverage.missing }));
  }
  if (coverage.close) {
    parts.push(t("{count} probably the same", { count: coverage.close }));
  }
  if (coverage.nofolder) {
    parts.push(t("{count} no folder", { count: coverage.nofolder }));
  }
  return parts.join(", ");
}

function renderAccounts(status) {
  $("accounts").replaceChildren(
    ...status.accounts.map(account => {
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = account.enabled;
      toggle.addEventListener("change", async () => {
        const { disabledAccounts } = await browser.storage.local.get(DEFAULTS);
        const disabled = new Set(disabledAccounts);
        toggle.checked ? disabled.delete(account.key) : disabled.add(account.key);
        await browser.storage.local.set({ disabledAccounts: [...disabled] });
      });
      const active = document.createElement("td");
      active.append(toggle);
      return row(
        active,
        account.name,
        cell(account.error || STATES()[account.state] || account.state, `state-${account.state}`),
        cell(account.folders, "num"),
        cell(account.messages, "num"),
        coverageText(account.coverage),
        time(account.lastSync)
      );
    })
  );
  $("empty").hidden = status.accounts.length > 0;
}

let shownDiagnosis = "";

function renderDiagnosis(status) {
  // Re-render only on changes, so buttons in the table keep working.
  const key = JSON.stringify(status.accounts.map(a => [a.name, a.coverage, a.unreadable]));
  if (key == shownDiagnosis) {
    return;
  }
  shownDiagnosis = key;
  const parts = [];
  for (const account of status.accounts) {
    const rows = problemRows(account);
    if (!rows.length) {
      continue;
    }
    if (status.accounts.length > 1) {
      parts.push(Object.assign(document.createElement("h3"), { textContent: account.name }));
    }
    parts.push(
      table([t("Problem"), t("Messages"), t("What it means"), t("What you can do")], rows.map(r => [r[0], cell(r[1], "num"), r[2], r[3]]))
    );
    const examples = account.coverage?.examples ?? [];
    if (examples.length) {
      parts.push(Object.assign(document.createElement("h3"), { textContent: t("Examples without folder") }));
      parts.push(table([t("Date"), t("From"), t("Subject")], examples.map(e => [day(e.date), e.author ?? "", e.subject])));
    }
  }
  if (!parts.length) {
    parts.push(Object.assign(document.createElement("p"), { className: "muted", textContent: t("No problems found.") }));
  }
  $("diagnosis").replaceChildren(...parts);
}

function checkState(c) {
  if (!c) {
    return t("not run since Thunderbird started");
  }
  if (c.running) {
    return t("running, {searched} of {folders} folders searched", { searched: c.searched, folders: c.folders });
  }
  return [
    c.auto ? t("daily run done") : t("run done"),
    c.after == null ? "" : t("no folder: {before} before, {after} now", { before: c.before, after: c.after }),
    c.error ? t("with errors: {error}", { error: c.error }) : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function renderServerCheck(status) {
  const rows = status.accounts.map(({ name, lastServerCheck, serverCheck: c }) => [
    name,
    time(lastServerCheck) || t("never"),
    checkState(c),
    cell(c ? c.messages : "", "num"),
    c ? c.repaired.join(", ") || t("none") : "",
    c ? c.rescanned.join(", ") || t("none") : "",
    c ? c.skipped.join(", ") : "",
  ]);
  $("serverCheck").replaceChildren(
    ...(rows.length
      ? [table([t("Account"), t("Last check"), t("State"), t("Messages looked up"), t("Repaired"), t("Rescanned"), t("Skipped")], rows)]
      : [])
  );
  const running = status.accounts.some(a => a.serverCheck?.running);
  for (const button of [$("checkServer"), ...document.querySelectorAll('[data-role="checkServer"]')]) {
    button.disabled = running;
  }
}

async function renderDiagnostics() {
  const log = $("diagLog");
  const text = (await browser.allMailPlus.getDiagnostics()).join("\n");
  if (log.value != text) {
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    log.value = text;
    if (atEnd) {
      log.scrollTop = log.scrollHeight;
    }
  }
}

async function copyDiagnostics() {
  const log = $("diagLog");
  try {
    await navigator.clipboard.writeText(log.value);
  } catch {
    log.select();
    document.execCommand("copy");
  }
  pageNotice = t("The diagnostics log was copied.");
}

async function render() {
  renderDiagnostics();
  const status = await browser.allMailPlus.getStatus();
  renderAccounts(status);
  renderDiagnosis(status);
  renderServerCheck(status);
  $("notice").textContent = pageNotice || status.lastNotice || t("None since Thunderbird started.");
}

let problems = [];
let pageNotice = "";

function renderProblems() {
  const filter = $("problemFilter").value;
  const shown = problems.filter(m => !filter || m.problem == filter);
  $("problemCount").hidden = false;
  $("problemCount").textContent = t("{shown} of {total} messages.", { shown: shown.length, total: problems.length });
  const several = new Set(problems.map(m => m.account)).size > 1;
  const headers = [...(several ? [t("Account")] : []), t("Date"), t("From"), t("Subject"), t("Problem"), t("Details")];
  const list = table(
    headers,
    shown.map(m => [
      ...(several ? [m.account] : []),
      day(m.date),
      m.author,
      m.subject,
      PROBLEMS()[m.problem] ?? m.problem,
      m.detail,
    ])
  );
  [...list.tBodies[0].rows].forEach((tr, i) => {
    tr.className = "clickable";
    tr.title = t("Show this message in All Mail");
    tr.tabIndex = 0;
    tr.addEventListener("click", () => showMessage(shown[i]));
    tr.addEventListener("keydown", e => e.key == "Enter" && showMessage(shown[i]));
  });
  $("problems").replaceChildren(list);
}

async function showMessage(message) {
  try {
    await browser.allMailPlus.showMessage(message.uri);
  } catch {
    pageNotice = t('"{subject}" is no longer in All Mail. Show the list again.', { subject: message.subject });
    render();
  }
}

async function showProblems() {
  const accounts = await browser.allMailPlus.listProblems();
  problems = accounts.flatMap(a => a.messages.map(m => ({ ...m, account: a.name })));
  const kinds = [...new Set(problems.map(m => m.problem))];
  $("problemFilter").replaceChildren(
    new Option(t("All"), ""),
    ...kinds.map(kind => new Option(`${PROBLEMS()[kind] ?? kind} (${problems.filter(m => m.problem == kind).length})`, kind))
  );
  $("problemFilterRow").hidden = false;
  renderProblems();
}

async function listFolders() {
  const accounts = await browser.allMailPlus.listServerFolders();
  const rows = accounts.flatMap(a => a.folders.map(f => [a.name, f.path, f.subscribed ? t("yes") : t("no")]));
  $("serverFolders").replaceChildren(
    rows.length
      ? table([t("Account"), t("Server folder"), t("Subscribed")], rows)
      : Object.assign(document.createElement("p"), {
          className: "muted",
          textContent: t("Every folder on the server also exists in Thunderbird, so no folder is hidden by a missing subscription."),
        })
  );
}

async function run(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (e) {
    pageNotice = t("{action} failed: {error}", { action: button.textContent, error: e.message });
  } finally {
    button.disabled = false;
    render();
  }
}

async function init() {
  I18N.localize(document);
  const config = await browser.storage.local.get(DEFAULTS);
  $("syncOnStartup").checked = config.syncOnStartup;
  $("checkIntervalMinutes").value = config.checkIntervalMinutes;
  $("dailyServerCheck").checked = config.dailyServerCheck;
  const stored = await browser.storage.local.get(null);
  $("verifyMode").value =
    !("verifyMode" in stored) && stored.verifyOnServer === false ? "never" : config.verifyMode;
  $("diagnostics").checked = config.diagnostics;
  $("diagnostics").addEventListener("change", e => browser.storage.local.set({ diagnostics: e.target.checked }));
  $("copyDiag").addEventListener("click", e => run(e.target, copyDiagnostics));
  $("clearDiag").addEventListener("click", e => run(e.target, () => browser.allMailPlus.clearDiagnostics()));
  $("verifyMode").addEventListener("change", e => browser.storage.local.set({ verifyMode: e.target.value }));
  $("syncOnStartup").addEventListener("change", e => browser.storage.local.set({ syncOnStartup: e.target.checked }));
  $("checkIntervalMinutes").addEventListener("change", e => {
    const minutes = Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || 5));
    e.target.value = minutes;
    browser.storage.local.set({ checkIntervalMinutes: minutes });
  });
  $("dailyServerCheck").addEventListener("change", e => browser.storage.local.set({ dailyServerCheck: e.target.checked }));
  $("sync").addEventListener("click", e => run(e.target, () => browser.allMailPlus.syncNow()));
  $("rebuild").addEventListener("click", e => run(e.target, () => browser.allMailPlus.rebuild()));
  $("checkServer").addEventListener("click", e => run(e.target, () => browser.allMailPlus.checkServer()));
  $("listFolders").addEventListener("click", e => run(e.target, listFolders));
  $("showProblems").addEventListener("click", e => run(e.target, showProblems));
  $("openSearch").addEventListener("click", e => run(e.target, () => browser.allMailPlus.openNoFolderSearch()));
  $("problemFilter").addEventListener("change", renderProblems);
  render();
  setInterval(render, 2000);
}

I18N.load(browser.i18n.getUILanguage()).then(init);
