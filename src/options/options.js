"use strict";

const DEFAULTS = { syncOnStartup: true, syncIntervalMinutes: 15, dailyServerCheck: true, disabledAccounts: [] };
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
  size: ["Size differs", "A real copy with the same Message-ID has another size."],
  date: ["Date differs", "A real copy with the same Message-ID has another date."],
  "size-date": ["Size and date differ", "A real copy with the same Message-ID differs in size and date."],
};

const day = ms => (ms ? new Date(ms).toLocaleDateString() : "");
const time = ms => (ms ? new Date(ms).toLocaleString() : "");

const topDeltas = (map, unit) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([delta, n]) => `${delta > 0 ? "+" : ""}${delta} ${unit} (${n}x)`)
    .join(", ");

/** Rows of the problem table: [problem, count, meaning, details]. */
function problemRows(account) {
  const { coverage, unreadable } = account;
  const rows = [];
  if (coverage?.ambiguous) {
    rows.push([PROBLEMS.ambiguous, coverage.ambiguous, "Several real folders hold a matching copy. They are synced again.", ""]);
  }
  for (const [key, n] of Object.entries(coverage?.reasons ?? {})) {
    const [name, meaning] = REASONS[key] ?? [key, ""];
    const deltas = [
      key != "date" && topDeltas(coverage.sizeDeltas, "bytes"),
      key != "size" && topDeltas(coverage.dateDeltas, "s"),
    ].filter(Boolean);
    rows.push([name, n, meaning, deltas.join("; ")]);
  }
  if (coverage?.nofolder) {
    rows.push([
      PROBLEMS.nofolder,
      coverage.nofolder,
      "Only in All Mail, or in a folder whose local list is out of date. The server check tells them apart.",
      "Actions file them into the target folder.",
    ]);
  }
  if (unreadable?.length) {
    rows.push(["Unreadable folders", unreadable.length, "Thunderbird could not open these folders.", unreadable.join(", ")]);
  }
  return rows;
}

function coverageText(coverage) {
  if (!coverage) {
    return "";
  }
  const parts = [`${coverage.unique} unique`];
  if (coverage.ambiguous) {
    parts.push(`${coverage.ambiguous} ambiguous`);
  }
  if (coverage.missing) {
    parts.push(`${coverage.missing} not found`);
  }
  if (coverage.nofolder) {
    parts.push(`${coverage.nofolder} without folder`);
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
        cell(account.error || account.state, `state-${account.state}`),
        cell(account.folders, "num"),
        cell(account.messages, "num"),
        coverageText(account.coverage),
        time(account.lastSync)
      );
    })
  );
  $("empty").hidden = status.accounts.length > 0;
}

function renderDiagnosis(status) {
  const parts = [];
  for (const account of status.accounts) {
    const rows = problemRows(account);
    if (!rows.length) {
      continue;
    }
    if (status.accounts.length > 1) {
      parts.push(Object.assign(document.createElement("h3"), { textContent: account.name }));
    }
    parts.push(table(["Problem", "Messages", "Meaning", "Details"], rows.map(r => [r[0], cell(r[1], "num"), r[2], r[3]])));
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

function renderServerCheck(status) {
  const rows = status.accounts
    .filter(a => a.serverCheck)
    .map(({ name, serverCheck: c }) => [
      name,
      c.running ? `running, ${c.searched} of ${c.folders} folders searched` : c.error ? `failed: ${c.error}` : `done ${time(c.finishedAt)}`,
      cell(c.messages, "num"),
      c.repaired.join(", ") || "none",
      c.rescanned.join(", ") || "none",
      c.busy.join(", "),
    ]);
  const last = Object.assign(document.createElement("p"), {
    className: "muted",
    textContent: `Last check: ${time(status.lastServerCheck) || "never"}.`,
  });
  $("serverCheck").replaceChildren(
    last,
    ...(rows.length
      ? [table(["Account", "State", "Messages looked up", "Repaired folders", "Rescanned folders", "Busy, skipped"], rows)]
      : [])
  );
  $("checkServer").disabled = status.accounts.some(a => a.serverCheck?.running);
}

async function render() {
  const status = await browser.allMailPlus.getStatus();
  renderAccounts(status);
  renderDiagnosis(status);
  renderServerCheck(status);
  $("notice").textContent = status.lastNotice || "None.";
}

let problems = [];

function renderProblems() {
  const filter = $("problemFilter").value;
  const shown = problems.filter(m => !filter || m.problem == filter);
  $("problemCount").hidden = false;
  $("problemCount").textContent = `${shown.length} of ${problems.length} messages.`;
  const several = new Set(problems.map(m => m.account)).size > 1;
  const headers = [...(several ? ["Account"] : []), "Date", "From", "Subject", "Problem", "Details"];
  $("problems").replaceChildren(
    table(
      headers,
      shown.map(m => [
        ...(several ? [m.account] : []),
        day(m.date),
        m.author,
        m.subject,
        PROBLEMS[m.problem] ?? m.problem,
        m.detail,
      ])
    )
  );
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
          textContent: "Thunderbird has every folder that is on the server.",
        })
  );
}

async function run(button, action) {
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
    render();
  }
}

async function init() {
  const config = await browser.storage.local.get(DEFAULTS);
  $("syncOnStartup").checked = config.syncOnStartup;
  $("syncIntervalMinutes").value = config.syncIntervalMinutes;
  $("dailyServerCheck").checked = config.dailyServerCheck;
  $("syncOnStartup").addEventListener("change", e => browser.storage.local.set({ syncOnStartup: e.target.checked }));
  $("syncIntervalMinutes").addEventListener("change", e =>
    browser.storage.local.set({ syncIntervalMinutes: Math.max(0, Number(e.target.value) || 0) })
  );
  $("dailyServerCheck").addEventListener("change", e => browser.storage.local.set({ dailyServerCheck: e.target.checked }));
  $("sync").addEventListener("click", e => run(e.target, () => browser.allMailPlus.syncNow()));
  $("rebuild").addEventListener("click", e => run(e.target, () => browser.allMailPlus.rebuild()));
  $("checkServer").addEventListener("click", e => run(e.target, () => browser.allMailPlus.checkServer()));
  $("listFolders").addEventListener("click", e => run(e.target, listFolders));
  $("showProblems").addEventListener("click", e => run(e.target, showProblems));
  $("problemFilter").addEventListener("change", renderProblems);
  render();
  setInterval(render, 2000);
}

init();
