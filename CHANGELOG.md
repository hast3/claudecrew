# Changelog

## 0.41.2
- Uninstaller (UNINSTALL.bat + uninstall.ps1)
- Guided Internet access (Cloudflare) settings page with step-by-step help
- publish needs --go
## 0.36.3
- Public export shows only example agents: real agent behaviour moved to private local settings; publish check covers names and file names
- Crew rule: judge work against the end goal, not just the brief
- Raise agent autocompact window to 160000 so runs condense less often
- Silent-run limit counts tool calls and output; stops and dropped hand-offs wake Assistant
- Raise handoff limit so handbacks aren't dropped
## 0.35.0
- Settings page in the menu: edit crew.config.json options from Crew
- Setup page: Install Claude Code and Sign in buttons
- Crew rule 16: nothing at the root of C:
- Crew rule 16: nothing at the root of C:
- Point-and-click setup page (/setup) for new installs: Claude check, name, helper folders, phone, start with Windows; installer opens it
- Guided tour: Welcome to Crew on first launch, spotlight steps, replay from menu
- publish.js: export commit skips the private repo's pre-commit hook (export has no crew.config.json); first public snapshot v0.31.1 pushed
## 0.31.1
- Public snapshots are now made by tools/publish.js: a scrubbed export with example config and no personal data
- Screen tools: desktop screenshots, clicks, typing and window control for agents while Computer control is ON
- Computer control switch in the header, with confirmation before turning it off while agents work
- Preview panel: run web apps through Crew and watch them live on PC and phone
- Status board from STATUS.md with each agent's latest item and who it is waiting on
- Waiting-on-you box with answer buttons for agent questions
- Automations: scheduled and event-driven jobs with a plain-language editor
- Credentials panel for app logins, kept out of chat
- Usage meters in the header, including a third weekly bar when used
- Silent-run watchdog, stale-handoff guard and a direct stop command per agent
- Per-run changed-files log with diff and undo
## 0.6.0
- Sidebar layout on desktop and a slide-out crew drawer on phones, with unread badges and a compact header menu.
- Integrations panel: linked MCP servers, services and secret-looking environment variable names (values are never read), and which agents can reach them.
- Layout preferences (order, groups, pins) sync through the server, so a refresh or another browser keeps them.
- Start a message with ! to make it urgent: it skips the concurrency cap and the budget hold.
- Stop-all button, friendlier activity labels, queued badge.
- Automatic fresh conversation when an agent's context gets heavy or a session runs long, carrying a short summary forward.
## 0.5.0
- Groups: put agents into named containers (agent dialog > Group, or drag a card onto another). Groups collapse and show a status summary. Saved per browser.
- Notes pad: each group has a 📝 checklist of open and done items, saved on the server in `data/notes.json` (new `/api/notes` endpoints).
- Crew bar: drag to reorder, pin, pick a colour, and set a custom emoji per agent. Added more colour themes.

## 0.4.0
- New `install.ps1`: one PowerShell command installs Node.js and Claude Code if missing, downloads Crew to `C:Crew`, creates the config, starts it, joins a hub and sets up autostart. Run it again to update.
- Machines: **Get pairing code** now also shows a ready-to-paste install line for a new PC (needs the hub reachable via Cloudflare or `allowLan`).
- Setup docs reorganised around "what do I run, and when".

## 0.3.1
- Machines: new "Connect this PC to a hub" box in the panel. Enter the hub address and the pairing code, no config editing or restart. Problems (expired code, unreachable hub, Cloudflare blocking) are explained in plain words.
- Remote pairing now recommends a single Cloudflare Bypass rule for `api/presence/*` instead of a service token (the token still works).
- New endpoints `/api/machines/link`, `/connect` and `/disconnect`.

## 0.3.0
- Machines: new panel (🖥) showing which computers run Crew and whether they are online. Other installs pair once with a short code and send a heartbeat every 30 s. Remote machines can reach the hub through Cloudflare Access with a service token. See docs/MACHINES.md.
- New settings `machineName` and `presenceHub`; new endpoints under `/api/machines` and `/api/presence`.

## 0.2.1
- The page header now shows the installed version (for example v0.2.1).

## 0.2.0
- Update check: Crew looks for a newer GitHub release at start and every 6 hours (quietly, if it can't reach GitHub). A button in the page header shows "Update available (vX)".
- One-click update from the PC Crew runs on. A git clone is fast-forwarded to the release; a zip install has the release files copied over it. `crew.config.json`, `data/`, `workspace/` and `.env` files are never touched.
- New endpoint `GET /api/update`.

## 0.1.0
- First public release.