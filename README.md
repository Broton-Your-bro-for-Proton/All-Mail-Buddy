# All Mail Buddy

Thunderbird add-on for Proton Mail Bridge. Inside Proton's **All Mail** folder it

* shows the real folder of every message (cards view: a badge on the card,
  table view: the columns **Folder** and **Labels**, in German **Ordner** and
  **Labels**),
* makes Delete, Shift+Delete, Move, Copy, Archive, Junk, Not junk, Move again,
  drag and drop onto a folder and the row buttons act on the message in its
  real folder instead of the All Mail view of it.

Every other folder and account keeps Thunderbird's native behavior. Feasibility,
design and the matching rules are described in [PLAN.md](PLAN.md).

Status: test version, built and tested against Thunderbird 153.6.

## Install

1. `npm run build` creates `dist/allmail-buddy-<version>.xpi`.
2. The add-on is not signed. Either load it temporarily via
   *Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on* (pick
   `src/manifest.json`), or set `xpinstall.signatures.required` to `false` in the
   Config Editor and install the `.xpi` via *Add-ons and Themes > Install Add-on
   From File*.
3. The settings page (*Add-ons and Themes > All Mail Buddy > Options*) shows the
   detected Bridge accounts, the index state and how many All Mail messages
   were matched.

## How matching works

Bridge serves the same message in All Mail and in its real folder, so both share
Message-ID, size and date. The add-on keeps an in-memory index of all real and
label folders and updates it on every add, delete, move and folder sync. A
message is only acted on when exactly one real copy matches. Otherwise nothing
is changed and a notification explains why.

Proton keeps every message in exactly one folder. When Thunderbird's local
copies disagree (two folders hold the message, or the only copy differs in size
or date), one of those folders has not been synced since the message moved.
The add-on then syncs exactly those folders again and re-checks, at most once
every 10 minutes per folder, or after 30 seconds when you try an action on such
a message.

Thunderbird does not keep every IMAP folder up to date by itself, mostly only
the open one and those it checks for new mail. To catch changes made in other
Proton clients, the add-on asks Bridge for the message
count and next UID of every folder (IMAP STATUS) every 5 minutes (adjustable
from 1 to 60) and whenever All
Mail is opened, and syncs only the folders whose numbers changed or differ from
the local copy.
These checks are tiny: Bridge runs on the same machine and answers each STATUS
from its own database. There is no periodic full sync; all folders are synced
once when Thunderbird starts (can be turned off), and *Sync all folders now*
on the settings page does it on demand, for example after Thunderbird was
offline for a long time.

Copies of the same message may differ by up to 2 bytes in Thunderbird's stored
size, which is tolerated. The status page lists why the remaining messages have
no match and shows a few examples to look up in Proton.

## How actions work

* **Check on the server first.** Before deleting for good (Shift+Delete, or
  deleting a copy that is in Trash), the add-on asks the server with one IMAP
  SEARCH per folder whether the number Thunderbird
  has for that copy still holds that message, in batches of 100. If not,
  nothing is changed: when the number holds another message the folder is
  repaired (at most once a day), otherwise it is only loaded again, for example
  after the message was moved in another app. Offline, and for folders with
  changes made offline, the check is skipped and Thunderbird queues the action
  as usual. Bridge needs a few seconds per check, so actions that can be
  undone (move, archive, delete into Trash, junk) are not checked by default;
  the settings offer "before every action" and "never" too.
* **Copy is a move.** In Proton a message lives in one folder, so copying it
  into another folder of the same account files it there. The add-on therefore
  handles Copy and Ctrl+drag from a real folder to another folder of the same
  account like Move. Copies into a label, another account or a local folder
  stay copies.
* **Archive** moves to the account's Archive folder, without Thunderbird's
  yearly or monthly subfolders, which would become new Proton folders.
  Messages of other accounts in the same selection follow Thunderbird's own
  archive settings.
* **Delete** asks first when the real copy is already in Trash, also for the
  delete button on a row or card, because Proton then deletes it for good.
* Moving into All Mail, or into the containers "Folders" and "Labels", is
  refused with a notice.

## Messages without a folder

Proton can hold a message in All Mail only, with no folder at all. This happens
for example when an IMAP client moves a message to a local folder: the client
copies it out and deletes it from its Proton folder, but Proton only deletes
for good from Trash and Spam. The Folder column shows such messages as
"No folder".

Bridge refuses to move a message out of All Mail. Copying it into a folder,
however, files the one Proton message there instead of creating a second one.
For messages without a folder the add-on therefore copies from All Mail:
delete copies to Trash (also with Shift+Delete, since Proton only deletes for
good from Trash), move and drag copy to the target, archive copies to the
account's Archive folder, and junk copies to Spam or Trash depending on the
junk setting. The All Mail entry stays, and the column then shows the new
folder. These copies cannot be undone with Ctrl+Z: undoing an IMAP copy
expunges it, and Proton deletes for good what is expunged from Trash or Spam.
Messages are only treated as having no folder once every real folder has been
loaded from the server since Thunderbird started (by a sync, the change check
or opening it) and could be read; until then the column shows "..." for them
and actions on them are refused with a notice.

## Finding the affected messages

*Open saved search "No folder"* on the settings page creates a saved search
next to All Mail (once per account, local only) and opens it. It lists every
message without a folder each time it is opened, so they can be selected with
Ctrl+A and deleted, moved or archived together; the actions go through the
add-on as in All Mail. Handled messages stay in the list until the saved search
is opened again.

The saved search uses the search criterion *Folder (All Mail Buddy)*, which is
also available in *Search Messages* and in your own saved searches. It compares
its value with the Folder column, for example `Shops` or `No folder`, or with
the status `nofolder`, `ambiguous` or `missing`. It only works on the local
message list, not as a search on the server. Message filters can use it too,
but a message that just arrived may count as `nofolder` until its folder is
indexed.

In *Show all affected messages*, a click on a row selects that message in All
Mail.

The diagnosis on the settings page explains each problem in full sentences
and offers what can be done about it. For copies that differ in size or date,
*Repair N folders* runs Thunderbird's *Repair Folder* on exactly the folders
of that account that hold such a copy, at most 25 per click and each folder at
most once a day, and not while Thunderbird is offline. Repairing reloads the
folder's message list and downloads its offline copies again. If the
difference stays afterwards, the copies really differ (or All Mail itself is
out of date) and the add-on keeps refusing actions on them.

## Server check

A message can also look folderless because Thunderbird's local list of its real
folder no longer matches the server, for example after Bridge assigned new
UIDs. Thunderbird's normal sync only compares UIDs and flags, so it does not
notice; only *Repair Folder* fixes such a folder.

The server check finds those folders without repairing everything. It looks up
the Message-ID of every message without a folder with an IMAP SEARCH in each
real folder, 100 IDs per search. Thunderbird reports a hit with its local
header for that UID. When that local header is a different message, the
folder's local list is wrong, and only that folder is repaired with
Thunderbird's own *Repair Folder*. That repair also deletes the folder's
offline copies, which Thunderbird downloads again if offline sync is enabled.
Folders whose hit is the searched message are only rescanned.

The check runs from the settings page, and once a day per account when
messages without a folder exist and every folder has been loaded from the
server. One run looks up at most 500 messages; the next run continues with the
rest. Change checks keep running during the searches; only the repairs pause
syncs. The daily run can be turned off in the
settings, and it repairs the same folder at most once a week. Folders that hold
changes made while offline are never repaired, and the check does not run
while Thunderbird is offline.

*List server folders missing in Thunderbird* reads the full folder list from
the server, as the Subscribe dialog does, and shows every folder Thunderbird
does not have, with its subscription state.

The settings page shows the problems as a table. *Show all affected messages*
lists every All Mail message without exactly one matching copy, with date,
sender, subject, problem and details, and can be filtered by problem.

## Junk

Marking as junk follows Thunderbird's own setting under *Settings > Privacy &
Security > Junk*: when "move to the Junk folder" is enabled for manual marking,
the real message moves to Bridge's Spam folder. Not junk moves a message from
Spam back to the Inbox.

## Diagnostics

*Record diagnostics* in the settings logs how long the add-on's work takes,
when Thunderbird finishes loading Bridge folders, how long the search
criterion spends per search, and every moment Thunderbird does not respond
for more than 0.3 seconds, together with the add-on work running then. The
log stays on the computer; *Copy log* puts it on the clipboard for a bug
report.

## Development

```
npm test                    # unit tests (node:test)
npm run setup:thunderbird   # once: disposable Thunderbird in .cache/
npm run test:e2e            # real Thunderbird via Marionette in a scratch profile
npm run build               # package dist/*.xpi
```

`setup:thunderbird` downloads the official en-US Windows build of Thunderbird
153.6.0esr from archive.mozilla.org (about 80 MB), checks it against Mozilla's
SHA-512 sums and unpacks it into `.cache/thunderbird/` without installing it.
It also downloads Thunderbird's fake IMAP server from its test suite
(`Imapd.sys.mjs`, `Maild.sys.mjs`, `Auth.sys.mjs`, about 100 KB) from
hg-edge.mozilla.org, pinned to a comm-esr153 revision and checked by SHA-256, into
`.cache/fakeserver/`.
`test:e2e` runs that copy with a throwaway profile, so it never starts or reads
a Thunderbird that is installed on the machine. Another binary can be passed as
the first argument or via `TB_BINARY`. `E2E_SCREENSHOTS=<dir>` stores
screenshots of the cards view, the table view and the settings page.

## Manual check with a real Bridge account

The end-to-end test simulates the Bridge layout on Local Folders, and over
real IMAP with the fake server: the Folder column, the STATUS based sync, the
server check repairing a folder whose UID was reused for another message, and
the list of unsubscribed server folders. The fake server is not Bridge, though. Before relying
on the add-on with real mail, check once with Bridge running:

1. Open All Mail and confirm the badge or Folder column matches the folder
   shown in Proton's web app for a few messages.
2. Move one test message from All Mail to another folder, then press Ctrl+Z.
3. Delete one test message from All Mail and confirm it lands in Trash.
4. Drag one test message from All Mail onto a folder.
5. Delete one message shown as "No folder" and confirm in Proton's web app
   that it is now in Trash, and only once.
6. Run *Check server now* and compare the repaired folders with Proton's web
   app; run *List server folders missing in Thunderbird* once.

## Limits

* Actions are refused while the index is being built, and when a real copy
  with the same Message-ID exists but none matches its size and date. The
  check on the server catches a folder whose local list maps a number to
  another message. "Sync all folders now" on the settings page refreshes all
  folders.
* Marking as junk sets the junk score on the real message but does not train
  Thunderbird's Bayesian filter the way the native command does.
* The Search Messages dialog and message filters are not routed.
* The search criterion lives in a module that Thunderbird keeps loaded; a
  change to `lib/searchTerm.sys.mjs` itself needs a Thunderbird restart.
* Thunderbird internals change between versions, so the add-on requires
  Thunderbird 153 or later and should be re-tested after major updates.
