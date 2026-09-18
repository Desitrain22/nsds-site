# Security notes

This repository is **public**. The site it builds is public too, but the Drive folder behind it is
not, and the line between them is thinner than it looks. These are the rules that keep it intact.

## Reporting something

Email `hello@notsodailystandup.com`. Please don't open a public issue for anything that looks like
it grants access.

## Never commit

- OAuth clients, tokens or refresh tokens. All four Google identities this project uses keep their
  credentials in `~/.config` or `~/.clasprc.json` — see [INTEGRATIONS.md](INTEGRATIONS.md).
- The `PASSWORD` or `ADMIN_KEY` values. They are Apps Script **script properties**, set once at
  deploy time and never read from the tree. `tools/deploy-backend.sh` takes the passphrase as an
  argument so it never has to live in a file.
- Anything under `*.eml`, or full-resolution source art. Both are covered by `.gitignore`, which
  has comments explaining why — the event brief is an email thread with a sponsor's address in it.

Secrets are passed to tooling through the environment, never `argv`, because `argv` is visible in
`ps` to every process on the machine.

## Treat Drive and Dropbox ids as credentials, not names

This is the non-obvious one, and it is the rule most likely to be broken by accident.

A Drive file id, a Drive folder id, a Google Sheet id and a Dropbox `rlkey` share link are all
**capability URLs**: for anything shared "anyone with the link", possessing the id *is* the
authorization. There is no second check. So an id committed to a public repo is equivalent to
publishing the contents.

Practical consequences:

- **Don't add new ids to tracked files.** Especially not in bulk — migration plans, rename logs and
  audit dumps are the usual culprits, because they are generated and nobody reads them before
  committing. Write them to a scratch directory, or `.gitignore` them.
- **Don't put ids in documentation.** [INTEGRATIONS.md](INTEGRATIONS.md) deliberately has none.
- **Removing an id from git does not un-publish it.** Anything pushed to a public repo should be
  assumed copied. The only fix that actually works is changing the sharing on the underlying item,
  or revoking the share link at the source. Do that first; tidying the history afterwards is
  optional and much less important.
- **Performer material is personal data.** Clip-request sheets carry real names alongside private
  notes about people's sets. Treat a sheet id as you would the sheet.

## The backend's trust model

`videoreview/apps-script/Code.gs` is published, and that is fine — it holds no secrets, and hiding
it would be security by obscurity. But two properties of it are worth stating plainly, because they
determine how much the passphrase is protecting:

1. It is deployed **`ANYONE_ANONYMOUS`** and executes **as the deploying user**, holding full
   `drive` and `spreadsheets` scope. Every request runs with the owner's Drive privileges.
2. Therefore the passphrase is not "a password for a review page". It is the only thing between the
   open internet and an authenticated Drive session. Choose it accordingly, don't reuse it
   anywhere, and rotate it in Project Settings if it is ever shared more widely than intended.

Defence in depth that is already in place, and should stay:

- `checkPassword` **fails closed** — an unset property refuses every request rather than allowing
  them. The comment above it explains the deploy-ordering window that motivated this.
- Every `admin*` action requires the admin key **and** the passphrase. One alone is refused.
- One-shot bootstrap: `setup` and `setupAdmin` claim their property only if it is unset, so the
  endpoint cannot be re-keyed by whoever finds it next.
- `LockService` serialises all mutations, so a retry racing its original request cannot double-write.
- `assertHumanLayout` refuses to write to a sheet whose A–G header does not match exactly, which is
  what stops a malformed or mistargeted request from stamping over someone's document.

### Validate ids that arrive from a client

`folderId`, `sheetId` and `completedClipsFolderId` come off the request body. Any handler that
passes one to `DriveApp.getFolderById`, `SpreadsheetApp.openById` or a create-if-missing path is
acting on a caller-supplied pointer with the owner's full Drive rights, so it should first check
that the target is inside the media root this app is supposed to touch. An id that is well-formed
is not the same as an id this app should open.

Adding a new action? Assume the caller has read `Code.gs`, knows every action name and payload
shape, and is not the web page. That is the accurate threat model for an anonymous-access web app.

## CORS is a calling convention here, not a control

Requests post `Content-Type: text/plain` with a JSON body because Apps Script cannot answer a CORS
preflight. That is a workaround for a browser restriction — it is not access control, and it stops
nobody using `curl`. The passphrase is the control.

## What the site itself exposes

`/videoreview` is `noindex, nofollow` and gated, but that is obscurity plus a shared secret, not
per-user auth: there are no accounts, and every performer who can reach a show can read that show's
other requests. The proof tapes are **unlisted** YouTube videos, which means anyone holding a video
id can watch — unlisted rather than private because the embedded player refuses private videos.
Neither is a bug; both are deliberate trade-offs, and both are reasons not to publish ids.
