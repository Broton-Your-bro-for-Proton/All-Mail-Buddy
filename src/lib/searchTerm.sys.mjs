/*
 * The search criterion "Folder (All Mail Buddy)". Thunderbird cannot remove a
 * custom search term, so this module registers one thin term per session and
 * stays loaded; the experiment sets the implementation it delegates to, and a
 * reloaded or updated add-on simply replaces that implementation.
 */
import { MailServices } from "resource:///modules/MailServices.sys.mjs";

export const SEARCH_TERM_ID = "allmailplus@hypercrisis#location";

const term = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchCustomTerm"]),
  id: SEARCH_TERM_ID,
  impl: null,
  needsBody: false,
  get name() {
    return term.impl?.name() ?? "Folder (All Mail Buddy)";
  },
  getEnabled(scope) {
    return term.impl?.available(scope) ?? false;
  },
  getAvailable(scope) {
    return term.impl?.available(scope) ?? false;
  },
  getAvailableOperators() {
    return term.impl?.operators() ?? [];
  },
  match(hdr, value, op) {
    try {
      return !!term.impl?.match(hdr, value, op);
    } catch (e) {
      console.error("All Mail Buddy: search term", e);
      return false;
    }
  },
};

MailServices.filters.addCustomTerm(term);

/** @param {?object} impl - {name, available, operators, match}, or null to match nothing */
export function setImplementation(impl) {
  term.impl = impl;
}
