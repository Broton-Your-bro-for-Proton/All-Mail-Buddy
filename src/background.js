"use strict";

const DEFAULTS = { syncOnStartup: true, syncIntervalMinutes: 15, disabledAccounts: [] };

const columnNames = {
  folder: browser.i18n.getMessage("columnFolder"),
  labels: browser.i18n.getMessage("columnLabels"),
};

const loadConfig = async () => ({ ...(await browser.storage.local.get(DEFAULTS)), columnNames });

browser.allMailPlus.onNotice.addListener(message =>
  browser.notifications.create({ type: "basic", title: "All Mail+", message, iconUrl: "icons/icon.svg" })
);

browser.storage.onChanged.addListener(async () => browser.allMailPlus.configure(await loadConfig()));

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

loadConfig().then(config => browser.allMailPlus.start(config));
