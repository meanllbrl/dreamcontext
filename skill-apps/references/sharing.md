# Sharing an app

An app can be published to GitHub with no data, and installed by someone else from Shared Apps
(a private repo they were invited to) or from a public link ("Install from a link"). This page is what an agent does.
A publish is YOURS to do: the owner presses Share on the app's page and you get the job. You may
also ASK for a publish, an install, an update or a logo yourself (below, "Asking the owner"): his
Onayla on the card lets you do exactly that once. "My own copy", uninstall and keys stay his clicks.

## What travels and what never does

A publish reads the app's COMMITTED files only (commit first; an uncommitted change stops it), and
only what an app is made of: `dreamcontext-app.json`, `ASSISTANT.md`, `README.md`, `CHANGES.md`,
`LICENSE`, the icon, `server.{mjs,js,cjs,ts}`, `package.json`, `package-lock.json`, and
`public/`, `src/`, `lib/` (html, css, js, ts, json, svg, images, woff2, md, txt, and plain-text native sources:
`.m .mm .h .c .swift .sh`; no compiled output or archives), and up to three
store screenshots as flat images in `store/` (png, jpg, webp). `share.include`
in the manifest adds a folder. Everything else stays on the Mac and is listed as "stays". One exception stops the publish instead of
staying quiet: when a file that goes out names (a quoted path like `'./lib/x.m'` or `'tools/x.rb'`) a committed file
that stays, the gate blocks with `referenced-not-sent`, because the installed app would break. Add that
folder to `share.include`, or stop reading the file. Nobody can approve past it.

Never: `.env*`, `data/`, `node_modules/`, dotfiles, `CLAUDE.md`/`AGENTS.md`/`.claude/`, links,
files over 2 MB. One commit goes out, as the account's noreply address at `+0000`; the app's own
git history, name, e-mail and time zone never do.

**A publish never carries the app's data**, the team's hand-made data included. That is a separate
thing: the paths the manifest's `data` field declares shared, once the owner approves them, go to
teammates of the SAME brain through brain sync (the `/apps` skill, "The app's data"). Someone who
installs a published app into another brain gets the code with an empty data folder. A teammate
whose brain already holds the app's shared data and who installs the same app keeps its slug, so
the app opens on that data.

The gate stops a publish on: a key or token, an `.env` or setting value, an e-mail, a phone
number, a person's name (people, git name, Mac user), a home path, an account id, image metadata.
Nobody can pass those, not the owner and not you with `--approve`: fix the app. Generic words of the
owner's own (project, insight, objective, AI Team, MCP, linked repo names, long numbers) are lines
the owner lets go one by one: ask him in the chat, then pass their ids with `--approve`.

## Publishing (the owner pressed Share)

His click on the app's page opens a grant on this Mac for THAT app, for one hour and one publish,
and puts a prompt in Chat with it. There is no publish form: you do all of it. **Share** opens a
private publish (people he invites); **Share publicly** a public one (for good). The grant holds
that choice: you cannot turn a private click into a public publish (403 `grant_scope`).

1. Read every file that would go out: `dreamcontext apps publish <slug>` lists them. Open each
   one, and look at the pixels of every image and store screenshot.
2. Find personal or business data: names, customers, e-mails, keys, real numbers, home paths,
   account ids, sample data that is real. Clean it in the app's own folder and commit. Every fixed
   target moves into settings: write a `config` template in the manifest and read the values with
   `dc.config()` (page or backend) or `process.env.DC_CONFIG`:
   ```json
   "config": [
     { "key": "insight", "type": "insight", "label": "Which insight to watch", "required": true },
     { "key": "META_TOKEN", "type": "secret", "label": "Meta token" }
   ]
   ```
   Types: `text`, `number`, `choice` (+ `choices`), `secret` (a `.env` key, capitals), `insight`,
   `objective`, `agent`, `task-tag`, `mcp-tool`. A required empty setting keeps the app from starting.
   Fill the owner's own values with `dreamcontext apps config <slug> --set insight=<slug>` (never a
   secret; a key is the owner's: the secret card, or `apps secret <slug> <KEY>` in his terminal).
3. Write or refresh `README.md`, the store page (SKILL.md: tagline, What it does, Screenshots),
   then commit. What's new comes from `--note`.
4. `dreamcontext apps publish <slug> [--public]` again: the gate is the last hard stop. Fix every
   block in the app; never work around one.
5. Ask the owner ONE question, only for what you cannot decide: the GitHub usernames to invite (a
   private publish), what changed, and the generic-word lines he may let go.
6. Publish, with a 10 minute timeout on the command:
   `dreamcontext apps publish <slug> --go --grant <id> --note "<what changed>" [--public] [--invite <logins>] [--approve <ids>]`. The
   grant is spent the moment the push goes out; a publish the gate stopped frees it for a retry
   within the hour. Cut off or an error: run the SAME command again, it is safe. `grant_used`:
   it already went out, stop. `publish_running`: wait, never publish twice. Only `grant_expired`
   or `owner_page_only` (the app restarted), or `grant_replaced` (he opened a newer grant: use that
   one): ask him to press Share again and publish with the new grant, your work stays. A first
   private publish with no grant: ask with `--ask --invite <logins>`, or he presses Share; an
   `--ask` without `--invite` can go out to nobody.
7. End with a short plain list: what you cleaned, what went out, where.

Licence: a private share gets "invitees use it, nobody re-shares it"; a public one MIT. A public
publish is for good, so it needs the owner's own yes: his "Share publicly" click, or his Onayla on
an `--ask --public` card that shows it. To invite one more person to the version already out
(`--ask --invite` answers "Nothing changed since the last publish"), he presses Share on the
app's page.

## Asking the owner (publish, install, update, logo)

When the work needs one of these and no grant came with your prompt, ask; never hunt for another way.

1. Ask: `dreamcontext apps publish <slug> --ask [--note "…"] [--approve <ids>] [--invite <logins>] [--public]`,
   `dreamcontext apps install <owner/repo> --ask [--set key=value]`,
   `dreamcontext apps update <slug> --ask [--how merge|set-aside]`, or
   `dreamcontext apps logo <slug> <absolute path to a PNG or JPG> --ask`. The server builds the
   plan from its own reads and shows him ONE card (the notch; Telegram while he is away) with
   exactly what would happen: where it goes and to whom, the changed files, every permission
   change, what a merge would lose, the picture itself. The command waits 60 s for him by default (`--wait <s>`, at most 110).
2. Wait: still waiting, run `dreamcontext apps grant <request> --wait 100`. Rejected: stop, and do
   not ask again for 10 minutes (and only if something changed).
3. Spend: on Onayla you get one command with a one-hour, one-time grant (a chat line `[app onayı]`
   brings the same). Run it once, as given. It runs the plan he saw, nothing you add: flags on the
   spend are ignored. `stale_request`: the app changed after his yes, nothing ran; ask again.
   `grant_used`: it already ran, stop. `grant_expired`: run the SAME `--ask` again; the card says
   "Süresi doldu: yeniden onaylıyor musun?" and one tap gives a new hour. A grant that came from
   his Share click has no `--ask` to repeat: ask him to press Share again.

An update publish (a published app whose files changed) never asks about visibility or invitees:
it keeps the last publish's. The Apps page shows such an app with "Yerelde yayınlanmamış yeni
sürüm var." and "Güncellemeyi yayınla", which hands you the same job as Share, in update mode.

## Installing (the installer's side)

- `dreamcontext apps shared`: invitations and apps shared with this account.
- `dreamcontext apps install <owner/repo|link>`: the preview (who wrote it, what it runs, the
  addresses its code names, the settings it asks for). Installing is the owner's click, or his
  Onayla on your `--ask` card, which also shows: "This app was written by X. It runs on your Mac
  with your permissions."
- `dreamcontext apps config <slug> --suggest`: candidates from THIS project for each setting; fill
  them with `--set`. The installed app's keys go in the same way as the owner's own.

An installed app lives in `<project>-apps/installed/<slug>/` and runs like the owner's own apps.
You (and the app's own assistant) may change its code: the copy is then "changed", and an update
asks how to come in (Merge, Keep my changes aside, Make it my own copy) instead of overwriting it.

## Updates and my own copy

`dreamcontext apps update <slug>` checks and changes nothing; an update it finds shows as the Update
card on the app's page in Apps (the page also checks when it opens). Never pull, fetch, merge or
copy the original's code yourself, and neither does the app's own assistant: that skips every gate
below. An update is applied by the owner's click or his Onayla on your `apps update <slug> --ask`
card; any change to the manifest is a line on that card. Auto-update is off unless he turns it on for that app (never for a
public app), and applies only to an unchanged copy with an unchanged manifest. "Make it my own
copy" stops updates for good. A copy can be published again only if its licence allows (MIT and
the like), under the new owner's name, with "Derived from <repo>" in its README.

Uninstall moves the app, its settings and its source to the trash; the Apps page restores it.
Its data stays unless the owner ticks "delete its data too".
