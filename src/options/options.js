"use strict";

const DEFAULTS = {
  syncOnStartup: true,
  checkIntervalMinutes: 5,
  dailyServerCheck: true,
  verifyOnServer: true,
  disabledAccounts: [],
};

const STATES = {
  ready: "Ready",
  indexing: "Reading folders...",
  syncing: "Syncing...",
  pending: "Waiting",
  disabled: "Off",
  error: "Error",
};
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

const PROBLEMS = {
  ambiguous: "Ambiguous",
  missing: "Copy differs",
  nofolder: "No folder",
};

const REASONS = {
  size: "Size differs",
  date: "Date differs",
  "size-date": "Size and date differ",
};

const day = ms => (ms ? new Date(ms).toLocaleDateString() : "");
const time = ms => (ms ? new Date(ms).toLocaleString() : "");

const topDeltas = (map, unit) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([delta, n]) => `${delta > 0 ? "+" : ""}${delta} ${unit} (${n}x)`)
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
  const { repaired, skipped, errors, unfixable, busy } = await browser.allMailPlus.repairDifferingFolders(account.key, kind);
  if (busy) {
    pageNotice = `Nothing was repaired: ${busy}. Try again in a moment.`;
    return;
  }
  pageNotice = [
    `Repaired: ${repaired.join(", ") || "none"}.`,
    skipped.length ? `Skipped: ${skipped.join(", ")}.` : "",
    errors.length ? `Problems: ${errors.join("; ")}.` : "",
    unfixable.length
      ? kind == "ambiguous"
        ? `${unfixable.join(", ")} still list the message after the repair, so Proton really keeps it more than ` +
          "once; these folders are not offered for repair again for 30 days."
        : `In ${unfixable.join(", ")} the copies still differ after the repair, so they really differ; ` +
          "these folders are not offered for repair again for 30 days."
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
      PROBLEMS.ambiguous,
      coverage.ambiguous,
      "Each of these All Mail messages matches a copy in more than one real folder, with the same Message-ID, " +
        "size and date. Proton keeps a message in a single folder, so either Thunderbird's list of one of these " +
        "folders is out of date, or Proton really holds two identical messages." +
        (self
          ? ` ${self} of them have a copy in Sent, so they are most likely messages you sent to yourself: Proton ` +
            "keeps those once in Sent and once in the folder they arrived in, and a repair cannot change that."
          : ""),
      actionCell(
        "The add-on syncs the folders involved again by itself. If that does not help, repair the folders that " +
          "hold these copies: Thunderbird then loads their message lists from the server again, which also " +
          "downloads their offline copies again if you keep any. Messages that stay ambiguous cannot be told " +
          "apart, so the add-on refuses delete, move and the other actions on them to avoid acting on the wrong " +
          "copy; handle them in their real folder, which the list shows." +
          (coverage.ambiguousUnfixable
            ? ` In ${coverage.ambiguousUnfixable} ${coverage.ambiguousUnfixable == 1 ? "folder" : "folders"} a ` +
              "repair did not help, so Proton really keeps those messages more than once."
            : ""),
        [
          ...(folders
            ? [
                [
                  `Repair ${folders} ${folders == 1 ? "folder" : "folders"}`,
                  () => repairDiffering(account, "ambiguous"),
                  "",
                  `Folders: ${(coverage.ambiguousNames ?? []).join(", ")}`,
                ],
              ]
            : []),
          ["Show them", () => showOnly("ambiguous")],
        ]
      ),
    ]);
  }
  if (coverage?.missing) {
    const reasons = Object.entries(coverage.reasons)
      .map(([key, n]) => `${n} ${(REASONS[key] ?? key).toLowerCase()}`)
      .join(", ");
    const deltas = [
      Object.keys(coverage.sizeDeltas).length && `The stored size is off by ${topDeltas(coverage.sizeDeltas, "bytes")}.`,
      Object.keys(coverage.dateDeltas).length && `The date is off by ${topDeltas(coverage.dateDeltas, "seconds")}.`,
    ].filter(Boolean);
    const folders = Math.min(coverage.differingFolders ?? 0, 25);
    const unfixable = coverage.unfixableFolders
      ? ` In ${coverage.unfixableFolders} ${coverage.unfixableFolders == 1 ? "folder" : "folders"} a repair ` +
        "did not help, so those copies really differ, for example two different messages that share a Message-ID."
      : "";
    rows.push([
      PROBLEMS.missing,
      coverage.missing,
      `A real folder holds a message with the same Message-ID, but Thunderbird stored it with another size or ` +
        `date than the All Mail copy (${reasons}). ${deltas.join(" ")} Often one of the two local copies is ` +
        "outdated because the message changed on the server. To be safe, the add-on treats them as different " +
        "messages and refuses actions on them.",
      actionCell(
        "Repair the folders that hold these copies: Thunderbird then loads their message lists from the server " +
          "again, which also downloads their offline copies again if you keep any. If the difference stays, the " +
          "copies really differ or All Mail itself is out of date; handle these messages in their real folder." +
          unfixable,
        [
          ...(folders
            ? [
                [
                  `Repair ${folders} ${folders == 1 ? "folder" : "folders"}`,
                  () => repairDiffering(account),
                  "",
                  `Folders: ${(coverage.differingNames ?? []).join(", ")}`,
                ],
              ]
            : []),
          ["Show them", () => showOnly("missing")],
        ]
      ),
    ]);
  }
  if (coverage?.nofolder) {
    rows.push([
      PROBLEMS.nofolder,
      coverage.nofolder,
      "No real folder in Thunderbird has a copy of these messages. Either Proton keeps them only in All Mail, " +
        "without any folder, which happens for example when an email program moved them to a local folder, or " +
        "Thunderbird's list of the folder that holds them is out of date." +
        (coverage.fullySynced
          ? ""
          : " Some folders have not been loaded from the server since Thunderbird started, so this number can " +
            'still drop; until then the Folder column shows "..." for these messages and actions wait.'),
      actionCell(
        "Run the server check: it finds the folders whose list is out of date and repairs only those. The " +
          "messages that remain really have no folder. Delete, move, archive and junk still work on them once every " +
          "folder could be read: the add-on files the message into the target folder, and delete puts it into " +
          "Trash. The saved search lists them all so you can handle them together.",
        [
          ["Check server now", () => browser.allMailPlus.checkServer(), "checkServer"],
          ['Open saved search "No folder"', () => browser.allMailPlus.openNoFolderSearch()],
        ]
      ),
    ]);
  }
  if (unreadable?.length) {
    rows.push([
      "Unreadable folders",
      unreadable.length,
      `Thunderbird could not open these folders, so their messages are missing from the index: ${unreadable.join(", ")}.`,
      actionCell(
        "Repair them in Thunderbird: right-click the folder, Properties, Repair Folder. Then click Rebuild index above."
      ),
    ]);
  }
  return rows;
}

function coverageText(coverage) {
  if (!coverage) {
    return "";
  }
  const parts = [`${coverage.unique} matched`];
  if (coverage.ambiguous) {
    parts.push(`${coverage.ambiguous} ambiguous`);
  }
  if (coverage.missing) {
    parts.push(`${coverage.missing} copy differs`);
  }
  if (coverage.nofolder) {
    parts.push(`${coverage.nofolder} no folder`);
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
        cell(account.error || STATES[account.state] || account.state, `state-${account.state}`),
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
      table(["Problem", "Messages", "What it means", "What you can do"], rows.map(r => [r[0], cell(r[1], "num"), r[2], r[3]]))
    );
    const examples = account.coverage?.examples ?? [];
    if (examples.length) {
      parts.push(Object.assign(document.createElement("h3"), { textContent: "Examples without folder" }));
      parts.push(table(["Date", "From", "Subject"], examples.map(e => [day(e.date), e.author ?? "", e.subject])));
    }
  }
  if (!parts.length) {
    parts.push(Object.assign(document.createElement("p"), { className: "muted", textContent: "No problems found." }));
  }
  $("diagnosis").replaceChildren(...parts);
}

function checkState(c) {
  if (!c) {
    return "not run since Thunderbird started";
  }
  if (c.running) {
    return `running, ${c.searched} of ${c.folders} folders searched`;
  }
  return `${c.auto ? "daily run" : "run"} done${c.error ? ` with errors: ${c.error}` : ""}`;
}

function renderServerCheck(status) {
  const rows = status.accounts.map(({ name, lastServerCheck, serverCheck: c }) => [
    name,
    time(lastServerCheck) || "never",
    checkState(c),
    cell(c ? c.messages : "", "num"),
    c ? c.repaired.join(", ") || "none" : "",
    c ? c.rescanned.join(", ") || "none" : "",
    c ? c.skipped.join(", ") : "",
  ]);
  $("serverCheck").replaceChildren(
    ...(rows.length
      ? [table(["Account", "Last check", "State", "Messages looked up", "Repaired", "Rescanned", "Skipped"], rows)]
      : [])
  );
  const running = status.accounts.some(a => a.serverCheck?.running);
  for (const button of [$("checkServer"), ...document.querySelectorAll('[data-role="checkServer"]')]) {
    button.disabled = running;
  }
}

async function render() {
  const status = await browser.allMailPlus.getStatus();
  renderAccounts(status);
  renderDiagnosis(status);
  renderServerCheck(status);
  $("notice").textContent = pageNotice || status.lastNotice || "None since Thunderbird started.";
}

let problems = [];
let pageNotice = "";

function renderProblems() {
  const filter = $("problemFilter").value;
  const shown = problems.filter(m => !filter || m.problem == filter);
  $("problemCount").hidden = false;
  $("problemCount").textContent = `${shown.length} of ${problems.length} messages.`;
  const several = new Set(problems.map(m => m.account)).size > 1;
  const headers = [...(several ? ["Account"] : []), "Date", "From", "Subject", "Problem", "Details"];
  const list = table(
    headers,
    shown.map(m => [
      ...(several ? [m.account] : []),
      day(m.date),
      m.author,
      m.subject,
      PROBLEMS[m.problem] ?? m.problem,
      m.detail,
    ])
  );
  [...list.tBodies[0].rows].forEach((tr, i) => {
    tr.className = "clickable";
    tr.title = "Show this message in All Mail";
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
    pageNotice = `"${message.subject}" is no longer in All Mail. Show the list again.`;
    render();
  }
}

async function showProblems() {
  const accounts = await browser.allMailPlus.listProblems();
  problems = accounts.flatMap(a => a.messages.map(m => ({ ...m, account: a.name })));
  const kinds = [...new Set(problems.map(m => m.problem))];
  $("problemFilter").replaceChildren(
    new Option("All", ""),
    ...kinds.map(kind => new Option(`${PROBLEMS[kind] ?? kind} (${problems.filter(m => m.problem == kind).length})`, kind))
  );
  $("problemFilterRow").hidden = false;
  renderProblems();
}

async function listFolders() {
  const accounts = await browser.allMailPlus.listServerFolders();
  const rows = accounts.flatMap(a => a.folders.map(f => [a.name, f.path, f.subscribed ? "yes" : "no"]));
  $("serverFolders").replaceChildren(
    rows.length
      ? table(["Account", "Server folder", "Subscribed"], rows)
      : Object.assign(document.createElement("p"), {
          className: "muted",
          textContent:
            "Every folder on the server also exists in Thunderbird, so no folder is hidden by a missing subscription.",
        })
  );
}

async function run(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (e) {
    pageNotice = `${button.textContent} failed: ${e.message}`;
  } finally {
    button.disabled = false;
    render();
  }
}

async function init() {
  const config = await browser.storage.local.get(DEFAULTS);
  $("syncOnStartup").checked = config.syncOnStartup;
  $("checkIntervalMinutes").value = config.checkIntervalMinutes;
  $("dailyServerCheck").checked = config.dailyServerCheck;
  $("verifyOnServer").checked = config.verifyOnServer;
  $("verifyOnServer").addEventListener("change", e => browser.storage.local.set({ verifyOnServer: e.target.checked }));
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

init();
