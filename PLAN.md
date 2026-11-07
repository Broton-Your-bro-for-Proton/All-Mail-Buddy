# All Mail+ for Thunderbird: feasibility and plan

Target: Thunderbird 153 with Proton Mail Bridge (IMAP). Goal: everything works
inside Proton's "All Mail" folder. Each message shows its real location, and
delete, move, copy, archive, junk and drag and drop act on the real message
instead of the All Mail view of it.

## Feasibility (verified against the Thunderbird 153.6 source in omni.ja)

| Feature | Verdict | Hook point in TB 153 |
| --- | --- | --- |
| "Location" column | Feasible | `ThreadPaneColumns.addCustomColumn()` (synchronous `textCallback(msgHdr)`) |
| "Labels" column | Feasible | same API, labels come from `Labels/*` and `Starred` |
| Location in cards view (TB 153 default) | Feasible | patch `thread-card.fillRow()` per `about:3pane` window and add a badge |
| Fast lookup | Feasible | in-memory index built from the folder databases (`nsIMsgDatabase.listAllKeys`) |
| Live updates | Feasible | `MailServices.mfn` (add, delete, move, key change) plus `FolderLoaded` rescans |
| Delete, Shift+Delete, Move, Copy, Archive, Junk, Not junk, Move again | Feasible | all UI paths (keys, menus, toolbar, header buttons, context menu) end in `commandController.doCommand()` of `about:3pane` / `about:message` |
| Drag and drop onto a folder | Feasible | `folderPane._onDrop()` in `about:3pane` |
| Row buttons (cards delete, junk icon column) | Feasible | `request-delete` and `toggle-spam` events, intercepted in the capture phase |
| Undo | Feasible | `copyMessages` / `deleteMessages` with `allowUndo` and the window's `msgWindow` |

Only the command paths of the All Mail folder are changed. Every other folder,
account and command keeps Thunderbird's native behavior.

Out of scope for the test version: the Search Messages dialog, message filters
running on All Mail, and other add-ons calling the WebExtension message API.

## Proton model

* Exclusive folders: `INBOX`, `Sent`, `Drafts`, `Archive`, `Spam`, `Trash`,
  `Folders/**` and anything else that is not listed below.
* Labels: `Labels/**` and `Starred`.
* Views: `All Mail`. The containers `Folders` and `Labels` hold no messages.

An account is treated as a Bridge account when its root has an `All Mail` folder
and a `Folders` or `Labels` folder. Detection can be switched off per account.

## Matching

Bridge serves the same message literal in every mailbox, so a message in All
Mail and its copy in the real folder share Message-ID, size and date.

1. Look up all index entries with the same Message-ID in the same account.
2. If more than one real folder entry exists, keep those with equal size and date.
3. Exactly one entry left: resolved. None: missing. Several: ambiguous.

Before any action the resolved header is re-read from its folder database and
checked again. If any selected message is missing or ambiguous, nothing is
changed and a notification explains why (atomic refusal).

## Action semantics in All Mail

| Action | Effect |
| --- | --- |
| Delete | `realFolder.deleteMessages()` honoring the account's delete model, with undo |
| Shift+Delete | permanent delete from the real folder, same confirmation as native |
| Move to folder | `copyMessages(realFolder, ..., isMove = true)` with undo |
| Move to a label folder or Starred | applies the label (copy), the message keeps its folder |
| Copy | `copyMessages(realFolder, ..., isMove = false)` |
| Archive | `MessageArchiver` on the real headers |
| Junk | junk score on real and All Mail headers, then the account's manual junk action (move to the junk folder or delete) |
| Not junk | junk score cleared, messages in the junk folder move to the Inbox |

After a move-like action the selection advances to the next row, as native.
The All Mail folder is refreshed afterwards so Bridge changes show up.

## Architecture

```
src/
  manifest.json          MV2, experiment API "allMailPlus"
  background.js          settings, notifications
  lib/core.js            pure logic (classification, index, matching), unit tested
  api/allMailPlus/       experiment: index, columns, window hooks, actions
  options/               status and settings page (Calibre-Web colors)
test/
  core.test.js           node:test unit tests
  e2e/run.mjs            real Thunderbird 153 run via Marionette in a scratch profile
```

## Design

Options page colors follow Calibre-Web: light theme from the default theme
(`#f2f2f2` page, `#f5f5f5` panels, `#45b29d` accent, `#444` text, `#999` muted,
`#ccc` borders), dark theme from caliBlur (`#474747` page, `#323232` panels,
`#282828` headers, `#f9be03` primary, `#cc7b19` secondary).

## Stages

1. Index and columns.
2. Actions on the real messages.
3. Native takeover of every UI path listed above.

All three are part of the test version.

## Verification

* Unit tests for the matching logic.
* End-to-end test in a scratch profile with a simulated Bridge folder layout on
  Local Folders, driven by Marionette against the installed Thunderbird binary.
* Manual test with the real Bridge account (see README).
