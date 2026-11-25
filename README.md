# Claude Crew

A chat room on your PC where several Claude Code agents each work in their own project folder and can hand work to each other. It runs on your Claude subscription through the `claude` command you already use, so there is no API key and no extra bill. Usage counts toward your plan's limits, the same as using Claude Code yourself.

## Start it

Crew starts by itself when Windows boots and runs in the background, with no window, even before you sign in. A **Crew icon in the system tray** appears when you sign in:

- Green dot: ready. Amber: agents working. Grey: not running.
- Double-click to open Crew. Right-click for the public address, reply notifications, **View log**, and **Restart Crew**.
- **Hide tray icon** removes only the icon. Crew keeps running.

**Start Crew.bat** opens Crew in your browser and brings the tray icon back if you hid it.

Background output goes to `data\crew.log`. To set up or remove the startup task (asks for admin once):

```
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall
```

## Uninstall

Double-click **UNINSTALL.bat** in the Crew folder (also attached to every GitHub release with `uninstall.ps1`). It stops Crew, removes the scheduled tasks, shortcuts, Claude Code conversations for the Crew agents and the Crew folder itself. It lists everything first and asks you to type REMOVE. Add `-DryRun` to only look, or `-KeepData` to keep your config, history, workspace and logins. Node.js, Git and Claude Code are left alone.

If agents reply with a login error, open a terminal and run `claude auth login` once.

## Talking to agents

| You type | Who gets it |
| --- | --- |
| `what should I work on today?` | The default agent (`defaultAgent` in the config) |
| `@webapp why does the login test fail?` | WebApp |
| `@webapp @docs ...` | Both |
| `@all status check` | Everyone |

Tap an agent's card to add its `@handle` to your message. ■ stops an agent, and ↺ starts it on a fresh conversation (it forgets what you've talked about so far). Otherwise each agent remembers its own conversation, even after a restart.

**Handoffs:** you just say what you want. The assistant passes project work to the one agent who owns it, and that agent's reply shows up in the chat. A chain stops after `maxHops` handoffs, so agents don't keep waking each other.

**Activity** shows each step an agent is taking (files read, commands run). **🔔** pops a notification when an agent replies while the tab is in the background.

## Features

- **Usage meter** (header): your plan's 5-hour and weekly usage, read from Claude Code on every agent reply. Tap it for reset times, a per-agent breakdown (runs and tokens), and the budget guard. The bars cover your whole account, including your own Claude Code use.
- **Budget guard**: when a window passes the level you set (default 5-hour 85%, weekly 95%), new work is held and runs automatically once that window resets. **Run anyway** overrides it until the reset. Change the levels in the usage panel, or under `settings.budget` (`enabled`, `fiveHour`, `weekly` as 0–1).
- **Needs you**: an agent's card gets a red **!** when it's waiting on you. If Claude Code refused it permission for something, the reply shows exactly what, with **Approve once and continue**. That allows only those exact actions, for that agent's next run.
- **What changed + undo**: replies list the files the turn changed. In git folders each file has a **diff**, and **Undo** restores the files to how they were before the turn. Undo skips any file that changed again afterwards.
- **Phone notifications** (🔔): real push notifications, even with Crew closed. On iPhone, add Crew to the home screen first (**Share → Add to Home Screen**), open it from there, then tap 🔔.
- **Scheduled jobs** (⏰): "weekdays at 08:00, @webapp run the tests" or "every 4 hours". Missed jobs run if Crew comes back within 6 hours. Jobs respect the budget guard.
- **Attachments** (📎 or paste): photos, screenshots, PDFs and text files, up to 15 MB each. The agent gets read access to them.
- **Live typing**: replies appear as the agent writes them.
- **Model per agent** (⋯ on a card): Default, Opus, Sonnet or Haiku. Default is Sonnet. The assistant raises a single job to Opus when the work is hard, or drops a lookup to Haiku. Pinning a model on the card overrides that.
- **Machines** (🖥): see which computers run Crew and whether they're online. Setup, including remote use through Cloudflare, is in [docs/MACHINES.md](docs/MACHINES.md).
- **Voice** (🎤): dictate in browsers that support it.

## crew.config.json

`settings`:

- `port`: the web address port (default 7777).
- `allowLan`: set to `true` to use Crew from your phone on the same Wi-Fi. The startup window then shows the address and an access key to enter on the phone. Windows will ask to allow Node through the firewall; allow it on **Private** networks only.
- `userName`: what agents call you.
- `defaultAgent`: who gets messages with no `@mention`.
- `maxHops`: the most agent-to-agent handoffs allowed in a row. `1` lets the assistant hand work off once; the worker's reply stays in the chat.
- `maxConcurrent`: how many agents can work at the same time. Keep this low to go easier on your plan's limits.
- `permissionMode`: what agents may do without asking, since nobody is at the terminal to approve:
  - `bypassPermissions` (default): agents can do anything except what the Crew guard (`lib/guard.js`, a PreToolUse hook on every run) refuses: recursive deletes on drive roots or outside the project folders, force-push or `reset --hard` on main/master, format/diskpart, deleting or overwriting game save files or files in your user folder outside the project folders, govc/ESXi power and destroy commands, and registry deletes. Each refusal lands on the "Permission needed" card with a plain reason; Approve lets it through.
  - `auto`: agents can edit and run things, and Claude Code's safety checks block anything they're unsure about.
  - `acceptEdits`: agents can edit files, but commands not on `allowedTools` are refused.
  - `manual`: agents can read and answer, but anything needing approval is refused.
- `machineName`, `presenceHub`: name this computer and optionally pair it to a hub. See [docs/MACHINES.md](docs/MACHINES.md).
- `model`: `null` lets Crew use Sonnet, which the assistant can override per job. Set `"opus"`, `"sonnet"`, or `"haiku"` to force one model for every agent.

`agents`: each one has an `id` (its @handle), `name`, `emoji`, `cwd` (its project folder), `description` (shown to teammates), and `instructions` (extra guidance for that agent only). Each can also override `permissionMode`, `model`, `allowedTools`, and `disallowedTools`.

Restart Crew after editing the config.

## Internet access (Cloudflare)

Easiest: **Settings > Set up internet access** in Crew guides you through it. `cloudflare` in the config opens a second entrance on `port` (default 7778), reachable only from this PC, for a Cloudflare Tunnel to connect to. Cloudflare Access shows the login page and MFA prompt. Crew then checks Cloudflare's signed login token on every request itself, including the signature, the `aud` tag, the team, the expiry, and that the email is in `allowedEmails`, so a mistake in the Cloudflare settings alone can't let anyone in.

- `hostname`: the public address, e.g. `crew.example.com`.
- `teamDomain`: your Zero Trust team domain, e.g. `myteam.cloudflareaccess.com`.
- `aud`: the Access application's "Application Audience (AUD) Tag".
- `allowedEmails`: who may use Crew. Keep this in step with the Access policy.

Point the tunnel's route at `http://localhost:7778`, never at 7777. 7777 is the local entrance, which trusts anything coming from this PC, and the tunnel connects from this PC.

## Changing Crew safely

Crew's own code is in git. After any change:

```
npm run check
git add -A
git commit -m "what changed"
```

- `npm run check` compiles the server, `lib/`, and every script in the web page without running them, and validates the JSON files. A single bad quote in `index.html` blanks the whole web UI, so the page is checked too.
- **Commits run the check first**, through a git pre-commit hook, and are refused if it fails.
- **To undo a bad edit:** `git restore <file>` (uncommitted), or `git log` then `git revert <commit>`.
- **Safety net:** if `index.html` ever has a code error anyway, Crew serves the last working version (`data/index.last-good.html`) with a red banner naming the file, line and error. The banner goes away on the next refresh after the fix.
- Agents follow the same steps (rule 10 in `crew-rules.md`).

## Files

- `server.js`: the app (Node, no dependencies).
- `public/index.html`: the chat page.
- `docs/`: extra guides (`MACHINES.md`).
- `lib/`: machines and presence (`presence.js`), usage tracking (`usage.js`), git snapshots/undo (`changes.js`), scheduled jobs (`scheduler.js`), Web Push (`webpush.js`), and the icon generator (`icons.js`).
- `data/`: chat log, each agent's conversation ID, the access key, generated agent prompts, `usage.json`, `schedules.json`, uploads, and push keys (`vapid.json`, `push-subscriptions.json`; keep these private). Delete `data/messages.jsonl` to clear the chat history.
- `workspace/`: folders for agents that don't belong to a project.
