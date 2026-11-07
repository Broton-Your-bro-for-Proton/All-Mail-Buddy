# All Mail+

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

1. `npm run build` creates `dist/allmailplus-<version>.xpi`.
2. The add-on is not signed. Either load it temporarily via
   *Tools > Developer Tools > Debug Add-ons > Load Temporary Add-on* (pick
   `src/manifest.json`), or set `xpinstall.signatures.required` to `false` in the
   Config Editor and install the `.xpi` via *Add-ons and Themes > Install Add-on
   From File*.
3. The settings page (*Add-ons and Themes > All Mail+ > Options*) shows the
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

Thunderbird itself only syncs an IMAP folder when it is opened. To catch
changes made in other Proton clients, the add-on asks Bridge for the message
count and next UID of every folder (IMAP STATUS) once a minute and whenever All
Mail is opened, and syncs only the folders whose numbers changed or differ from
the local copy.

Copies of the same message may differ by up to 2 bytes in Thunderbird's stored
size, which is tolerated. The status page lists why the remaining messages have
no match and shows a few examples to look up in Proton.

## Junk

Marking as junk follows Thunderbird's own setting under *Settings > Privacy &
Security > Junk*: when "move to the Junk folder" is enabled for manual marking,
the real message moves to Bridge's Spam folder. Not junk moves a message from
Spam back to the Inbox.

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
`test:e2e` runs that copy with a throwaway profile, so it never starts or reads
a Thunderbird that is installed on the machine. Another binary can be passed as
the first argument or via `TB_BINARY`. `E2E_SCREENSHOTS=<dir>` stores
screenshots of the cards view, the table view and the settings page.

## Manual check with a real Bridge account

The end-to-end test simulates the Bridge layout on Local Folders. Before relying
on the add-on with real mail, check once with Bridge running:

1. Open All Mail and confirm the badge or Folder column matches the folder
   shown in Proton's web app for a few messages.
2. Move one test message from All Mail to another folder, then press Ctrl+Z.
3. Delete one test message from All Mail and confirm it lands in Trash.
4. Drag one test message from All Mail onto a folder.

## Limits

* Actions are refused while the index is being built, and when no copy with
  the same Message-ID, size and date exists. Two distinct messages that agree
  on all three can still be confused if one of their folders was not synced
  yet. "Sync all folders now" on the settings page refreshes all folders.
* Marking as junk sets the junk score on the real message but does not train
  Thunderbird's Bayesian filter the way the native command does.
* The Search Messages dialog and message filters are not routed.
* Thunderbird internals change between versions, so the add-on requires
  Thunderbird 153 or later and should be re-tested after major updates.
