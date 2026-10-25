# Changelog

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
