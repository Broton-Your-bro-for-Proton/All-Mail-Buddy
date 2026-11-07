"use strict";

const DEFAULTS = { syncOnStartup: true, syncIntervalMinutes: 15, disabledAccounts: [] };
const $ = id => document.getElementById(id);

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className;
  return td;
}

const REASONS = {
  "no-copy": "no copy in a real folder",
  "label-only": "only in label folders",
  size: "size differs",
  date: "date differs",
  "size-date": "size and date differ",
};

const topDeltas = (map, unit) =>
  Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([delta, n]) => `${delta > 0 ? "+" : ""}${delta} ${unit} (${n}x)`)
    .join(", ");

/** Why All Mail messages were not matched, as plain sentences. */
function diagnosisText(account) {
  const { coverage, unreadable } = account;
  const lines = [];
  if (coverage?.missing) {
    const reasons = Object.entries(coverage.reasons).map(([key, n]) => `${n} ${REASONS[key] ?? key}`);
    lines.push(`Not found: ${reasons.join(", ")}.`);
    if (Object.keys(coverage.sizeDeltas).length) {
      lines.push(`Size of the closest copy is off by: ${topDeltas(coverage.sizeDeltas, "bytes")}.`);
    }
    if (Object.keys(coverage.dateDeltas).length) {
      lines.push(`Date of the closest copy is off by: ${topDeltas(coverage.dateDeltas, "s")}.`);
    }
  }
  if (coverage?.examples?.length) {
    const examples = coverage.examples.map(e => `"${e.subject}" (${new Date(e.date).toLocaleDateString()})`);
    lines.push(`Examples without any copy, to look up in Proton: ${examples.join(", ")}.`);
  }
  if (unreadable?.length) {
    lines.push(`Folders that could not be read: ${unreadable.join(", ")}.`);
  }
  return lines.join(" ");
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
  return parts.join(", ");
}

async function render() {
  const status = await browser.allMailPlus.getStatus();
  const body = $("accounts");
  body.replaceChildren(
    ...status.accounts.map(account => {
      const tr = document.createElement("tr");
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
      tr.append(
        active,
        cell(account.name),
        cell(account.error || account.state, `state-${account.state}`),
        cell(account.folders, "num"),
        cell(account.messages, "num"),
        cell(coverageText(account.coverage)),
        cell(account.lastSync ? new Date(account.lastSync).toLocaleString() : "")
      );
      const diagnosis = diagnosisText(account);
      if (!diagnosis) {
        return [tr];
      }
      const details = document.createElement("tr");
      details.className = "details";
      const td = cell(diagnosis, "muted");
      td.colSpan = 7;
      details.append(td);
      return [tr, details];
    }).flat()
  );
  $("empty").hidden = status.accounts.length > 0;
  $("notice").textContent = status.lastNotice || "None.";
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
  $("syncOnStartup").addEventListener("change", e => browser.storage.local.set({ syncOnStartup: e.target.checked }));
  $("syncIntervalMinutes").addEventListener("change", e =>
    browser.storage.local.set({ syncIntervalMinutes: Math.max(0, Number(e.target.value) || 0) })
  );
  $("sync").addEventListener("click", e => run(e.target, () => browser.allMailPlus.syncNow()));
  $("rebuild").addEventListener("click", e => run(e.target, () => browser.allMailPlus.rebuild()));
  render();
  setInterval(render, 2000);
}

init();
