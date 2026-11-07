# Sharing an app

An app can be published to GitHub with no data, and installed by someone else from Shared Apps
(a private repo they were invited to) or from a public link ("Install from a link"). This page is what an agent does.
A publish is YOURS to do: the owner presses Share on the app's page and you get the job. Installing,
updating and the rest stay his clicks on the Apps page.

## What travels and what never does

A publish reads the app's COMMITTED files only (commit first; an uncommitted change stops it), and
only what an app is made of: `dreamcontext-app.json`, `ASSISTANT.md`, `README.md`, `CHANGES.md`,
`LICENSE`, the icon, `server.{mjs,js,cjs,ts}`, `package.json`, `package-lock.json`, and
`public/`, `src/`, `lib/` (html, css, js, ts, json, svg, images, woff2, md, txt), and up to three
store screenshots as flat images in `store/` (png, jpg, webp). `share.include`
in the manifest adds a folder. Everything else stays on the Mac and is listed as "stays".

Never: `.env*`, `data/`, `node_modules/`, dotfiles, `CLAUDE.md`/`AGENTS.md`/`.claude/`, links,
files over 2 MB. One commit goes out, as the account's noreply address at `+0000`; the app's own
git history, name, e-mail and time zone never do.

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
6. Publish, with a 15 minute timeout on the command:
   `dreamcontext apps publish <slug> --go --grant <id> --note "<what changed>" [--public] [--invite <logins>] [--approve <ids>]`. The
   grant is spent the moment the push goes out; a publish the gate stopped frees it for a retry
   within the hour. Refused: `grant_expired` or `owner_page_only` (used, replaced, the app
   restarted): ask him to press Share again and publish with the new grant, your work stays;
   `publish_running`: wait, never publish twice.
7. End with a short plain list: what you cleaned, what went out, where.

Licence: a private share gets "invitees use it, nobody re-shares it"; a public one MIT. A public
publish is for good, so only the owner's own "Share publicly" click opens one.

## Installing (the installer's side)

- `dreamcontext apps shared`: invitations and apps shared with this account.
- `dreamcontext apps install <owner/repo|link>`: the preview (who wrote it, what it runs, the
  addresses its code names, the settings it asks for). Installing is the owner's click, which also
  shows: "This app was written by X. It runs on your Mac with your permissions."
- `dreamcontext apps config <slug> --suggest`: candidates from THIS project for each setting; fill
  them with `--set`. The installed app's keys go in the same way as the owner's own.

An installed app lives in `<project>-apps/installed/<slug>/` and runs like the owner's own apps.
You (and the app's own assistant) may change its code: the copy is then "changed", and an update
asks how to come in (Merge, Keep my changes aside, Make it my own copy) instead of overwriting it.

## Updates and my own copy

`dreamcontext apps update <slug>` checks. An update is applied by the owner's click; any change to
the manifest asks him again. Auto-update is off unless he turns it on for that app (never for a
public app), and applies only to an unchanged copy with an unchanged manifest. "Make it my own
copy" stops updates for good. A copy can be published again only if its licence allows (MIT and
the like), under the new owner's name, with "Derived from <repo>" in its README.

Uninstall moves the app, its settings and its source to the trash; the Apps page restores it.
Its data stays unless the owner ticks "delete its data too".
