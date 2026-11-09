"use strict";

const DEFAULTS = {
  syncOnStartup: true,
  checkIntervalMinutes: 5,
  dailyServerCheck: true,
  verifyMode: "permanent",
  diagnostics: false,
  disabledAccounts: [],
};

const columnNames = {
  folder: browser.i18n.getMessage("columnFolder"),
  labels: browser.i18n.getMessage("columnLabels"),
  noFolder: browser.i18n.getMessage("noFolder"),
};

const loadConfig = async () => {
  const stored = await browser.storage.local.get(null);
  const config = { ...DEFAULTS, ...stored, columnNames };
  // Earlier versions had an on/off switch; turned off stays off.
  if (!("verifyMode" in stored) && stored.verifyOnServer === false) {
    config.verifyMode = "never";
  }
  return config;
};

browser.allMailPlus.onNotice.addListener(message =>
  browser.notifications.create({ type: "basic", title: "All Mail Buddy", message, iconUrl: "icons/icon.svg" })
);

browser.storage.onChanged.addListener(async () => browser.allMailPlus.configure(await loadConfig()));

browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

loadConfig().then(config => browser.allMailPlus.start(config));
