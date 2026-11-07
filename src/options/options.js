"use strict";

const DEFAULTS = { syncOnStartup: true, syncIntervalMinutes: 15, disabledAccounts: [] };
const $ = id => document.getElementById(id);

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className;
  return td;
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
      return tr;
    })
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
