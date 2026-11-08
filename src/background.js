"use strict";

const DEFAULTS = {
  syncOnStartup: true,
  syncIntervalMinutes: 0,
  dailyServerCheck: true,
  verifyOnServer: true,
  disabledAccounts: [],
};

const columnNames = {
  folder: browser.i18n.getMessage("columnFolder"),
  labels: browser.i18n.getMessage("columnLabels"),
  noFolder: browser.i18n.getMessage("noFolder"),
};

const loadConfig = async () => ({ ...(await browser.storage.local.get(DEFAULTS)), columnNames });

browser.allMailPlus.onNotice.addListener(message =>
  browser.notifications.create({ type: "basic", title: "All Mail Buddy", message, iconUrl: "icons/icon.svg" })
);

browser.storage.onChanged.addListener(async () => browser.allMailPlus.configure(await loadConfig()));

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

loadConfig().then(config => browser.allMailPlus.start(config));
