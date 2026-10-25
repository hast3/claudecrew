# Claude Crew

A chat room for a team of [Claude Code](https://docs.claude.com/en/docs/claude-code) agents. Each agent works in its own project folder, keeps its own conversation, and can hand work to a teammate. You talk to all of them from one web page, on your PC or your phone.

Crew drives the `claude` command you already have, so it runs on your Claude subscription (or whatever account your Claude Code is logged in with). There is no separate API key. Agent work counts toward your plan's usage limits, the same as using Claude Code yourself.

## Features
- **Machines** (🖥): see which computers run Crew and whether they are online. Setup, including remote use through Cloudflare, is in [docs/MACHINES.md](docs/MACHINES.md).

- **One chat, many agents.** Type `@id` to talk to one agent, `@a @b` for several, or `@all`. Messages with no mention go to a default agent.
- **Handoffs.** An agent can pass work to the teammate who owns it with a short brief. The chain is capped by `maxHops`, so agents don't keep waking each other.
- **Persistent sessions.** Each agent resumes its own Claude Code conversation, even after a restart. ↺ starts it fresh.
- **Live activity.** Replies stream in as the agent writes them, with each step shown (files read, commands run).
- **What changed + undo.** Each reply lists the files that turn changed. In git folders you get a per-file diff and one-click **Undo**.
- **Needs you.** When Claude Code refuses an action, the reply shows exactly what was refused, with **Approve once and continue**.
- **Usage meter and budget guard.** Shows your plan's 5-hour and weekly usage and holds new work above a level you set.
- **Scheduled jobs.** For example, "weekdays at 08:00, @webapp run the tests" or "every 4 hours".
- **Attachments.** Photos, screenshots, PDFs and text files, up to 15 MB each.
- **Push notifications.** Uses Web Push (VAPID, built in, no third-party service). Works on phones too, over HTTPS.
- **Installable web app (PWA)**, with voice dictation, a per-agent model choice, and light and dark themes.
- **No dependencies.** One Node file and one HTML page. Nothing to `npm install`.

## Requirements

- **Node.js 20 or newer.**
- **Claude Code CLI**, installed and logged in. Run `claude` once in a terminal and finish the login (or run `claude auth login`). A Claude Pro/Max subscription or another account Claude Code accepts.
- **OS:** Windows 10/11 is the main, tested platform. The server and web page are plain Node and run on macOS and Linux. The tray icon, autostart and launcher scripts are Windows-only (see [docs/SETUP.md](docs/SETUP.md#windows-only-pieces)).
- **git** (optional), for change tracking and undo in project folders.

## Quick start

New to Claude Code, Node.js or the terminal? Follow the beginner walkthrough first: [Start here: never used Claude Code](docs/SETUP.md#start-here-never-used-claude-code). It covers signing up, installing everything, logging in and a test that proves it works, with what you should see at each step.

Already set up:

```sh
git clone https://github.com/hast3/claudecrew claudecrew
cd claudecrew
cp crew.config.example.json crew.config.json     # Windows: copy crew.config.example.json crew.config.json
# edit crew.config.json: set "userName" to your name (agent folders are created for you)
npm start                                         # or: node server.js --open
```

Open <http://localhost:7777>. On Windows you can double-click **Start Crew.bat** instead.

[docs/SETUP.md](docs/SETUP.md) covers phone access, HTTPS, push notifications, autostart and troubleshooting.

## How it works

`server.js` is a small Node HTTP server with no dependencies. For each agent turn it spawns the `claude` CLI in that agent's `cwd`, adds a generated system prompt (who the agent is, its teammates, how handoffs work), resumes the agent's saved session and streams the JSON output back. The browser gets live updates over Server-Sent Events. The page is one file (`public/index.html`) with a service worker for push. State lives in `data/` (chat log, session IDs, usage, schedules, uploads, push keys). Small modules in `lib/` handle usage tracking (`usage.js`), git snapshots and undo (`changes.js`), scheduling (`scheduler.js`), Web Push (`webpush.js`) and icons (`icons.js`).

## Updating

When a newer release is published, a **⬆ Update available (vX)** button appears in the page header (on the PC Crew runs on). Click it and confirm. A git clone is fast-forwarded to the release; a zip install gets the new files copied over it. Your `crew.config.json`, `data/` and `workspace/` are never touched. Crew then restarts itself if it was started by the tray icon or `run-crew.cmd`; otherwise it tells you to restart it. Prefer the terminal? In a clone, `git pull --ff-only`. See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Configuration

All settings live in `crew.config.json`, which is git-ignored (start from `crew.config.example.json`). Environment variables override the file:

| Variable | Purpose | Default |
| --- | --- | --- |
| `CREW_CONFIG` | Path to the config file | `crew.config.json` |
| `CREW_DATA_DIR` | Where chat history, sessions and keys are stored | `data` |
| `CREW_PORT` | Web port | `settings.port`, else `7777` |
| `CREW_USER_NAME` | The name agents call you | `settings.userName`, else `You` |
| `CLAUDE_PATH` | Full path to the `claude` executable | found on `PATH` |
| `NODE_EXE` | Node used by `run-crew.cmd` (Windows) | found on `PATH` |

Relative paths are resolved from the Crew folder.
nTwo optional settings, `machineName` and `presenceHub`, name this computer and pair it to a hub. See [docs/MACHINES.md](docs/MACHINES.md).

## Privacy

Everything runs on your machine. `data/` holds your chat history, the LAN access key and your push keys, and `crew.config.json` holds your agents and paths. Both are git-ignored. Keep them that way, and never put tokens or passwords in the config. Agents read secrets from environment variables instead.

## License

MIT. See [LICENSE](LICENSE).

Made by [Hast3](https://github.com/hast3). Source: <https://github.com/hast3/claudecrew>.
