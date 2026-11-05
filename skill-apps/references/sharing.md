# Sharing an app

An app can be published to GitHub with no data, and installed by someone else from Shared Apps
(a private repo they were invited to) or from a public link ("Install from a link"). This page is what an agent does;
the decisions are the owner's clicks on the Apps page.

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
Nobody can pass those: fix the app. Generic words of the owner's own (project, insight, objective,
AI Team, MCP, linked repo names, long numbers) are lines the owner ticks one by one.

## Your part before a publish

1. Move every fixed target into settings: an insight slug, a member, an MCP tool, a label. Write a
   `config` template in the manifest and read the values with `dc.config()` (page or backend) or
   `process.env.DC_CONFIG`:
   ```json
   "config": [
     { "key": "insight", "type": "insight", "label": "Which insight to watch", "required": true },
     { "key": "META_TOKEN", "type": "secret", "label": "Meta token" }
   ]
   ```
   Types: `text`, `number`, `choice` (+ `choices`), `secret` (a `.env` key, capitals), `insight`,
   `objective`, `agent`, `task-tag`, `mcp-tool`. A required empty setting keeps the app from starting.
2. Fill the owner's own values: `dreamcontext apps config <slug> --set insight=<slug>` (never a
   secret; a key is the owner's: the secret card, or `apps secret <slug> <KEY>` in his terminal).
3. Fill `README.md` with the store skeleton (SKILL.md: tagline, What it does, Screenshots, What's new), then commit.
4. `dreamcontext apps publish <slug> [--public]`: the gate's report. Fix what stops it; tell the
   owner which generic lines wait for his tick. The push is his click: Apps page → the card → Share.

Licence: a private share gets "invitees use it, nobody re-shares it"; a public one MIT. A public
publish is for good, so the owner types the app's name to confirm.

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
