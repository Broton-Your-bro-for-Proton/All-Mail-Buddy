"use strict";

// Gettext-style UI texts: the English text is the key, src/locales/<code>.json maps it to a language.
// A missing entry shows the English text. Placeholders are written {name}. Loaded as a plain script by
// the background page and the settings page; the experiment gets the catalog with its config.
const I18N = (() => {
  // Every UI language besides English (the store's languages).
  const LOCALES = [
    "af", "ar", "ast", "az", "bg", "bn", "bs", "ca", "cak", "cs", "da", "de", "dsb", "el", "es", "eu", "fa", "fi",
    "fr", "fy-NL", "ga-IE", "gu", "he", "hsb", "hu", "id", "it", "ja", "ka", "kab", "ko", "mk", "mn", "ms", "nb-NO",
    "nl", "nn-NO", "pa-IN", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sq", "sv-SE", "te", "th", "tr", "uk",
    "ur", "vi", "zh-CN", "zh-TW",
  ];
  let catalog = null; // null = English

  /** The supported locale for a language tag: the exact one (pt-BR), else the first of that language (pt), else English. */
  const match = tag => {
    const want = String(tag ?? "").replace("_", "-").toLowerCase();
    const base = want.split("-")[0];
    return LOCALES.find(l => l.toLowerCase() == want) ?? LOCALES.find(l => l.toLowerCase().split("-")[0] == base) ?? "en";
  };

  const t = (text, params) => {
    const out = catalog && Object.hasOwn(catalog, text) ? catalog[text] : text;
    return params ? out.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m)) : out;
  };

  /** The key of a text node: trimmed, inner whitespace as single spaces. */
  const pageText = text => text.trim().replace(/\s+/g, " ");

  return {
    LOCALES,
    match,
    t,
    pageText,
    /** Loads the catalog of a language; resolves to it (null for English). */
    async load(lang) {
      const code = match(lang);
      try {
        catalog = code == "en" ? null : await (await fetch(browser.runtime.getURL(`locales/${code}.json`))).json();
      } catch (e) {
        // A missing catalog must not stop the add-on: it then shows English.
        console.error("All Mail Buddy: no UI texts for", code, e);
        catalog = null;
      }
      return catalog;
    },
    /** Translates the static text of a page: text nodes, the title and title/placeholder/aria-label attributes. */
    localize(doc) {
      if (!catalog) {
        return;
      }
      doc.documentElement.lang = match(browser.i18n.getUILanguage());
      doc.title = t(doc.title);
      const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const key = pageText(node.nodeValue);
        if (key && Object.hasOwn(catalog, key)) {
          const [, before, , after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(node.nodeValue);
          node.nodeValue = before + catalog[key] + after;
        }
      }
      for (const el of doc.querySelectorAll("[title], [placeholder], [aria-label]")) {
        for (const attr of ["title", "placeholder", "aria-label"]) {
          if (el.hasAttribute(attr)) {
            el.setAttribute(attr, t(el.getAttribute(attr)));
          }
        }
      }
    },
  };
})();
const t = I18N.t;
