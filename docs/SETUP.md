# Setting up Claude Crew

## What do I run, and when?

| Your situation | Run this | Where |
| --- | --- | --- |
| **Windows, first time** (this is the normal case) | `irm https://raw.githubusercontent.com/hast3/claudecrew/main/install.ps1 \| iex` | PowerShell, any folder |
| **Adding another PC to a Crew you already run** | Hub's **Machines → Get pairing code**, then paste the one line it shows | PowerShell on the new PC |
| **Updating** | Click **⬆ Update available** in Crew. Or run the first-time command again: it updates and never touches your settings | Crew page, or PowerShell |
| **Mac, Linux, or you prefer to do it by hand** | [Manual install](#manual-install-mac-linux-or-by-hand) below | Terminal |

### What the Windows command does

It checks each item and only does what is missing, so it is safe to run twice:

1. Installs **Node.js** (LTS) if you don't have version 20+.
2. Installs **Claude Code** if `claude` isn't found.
3. Downloads the latest Crew into **`C:Crew`** (add `-Dir D:somewhere` to choose another folder).
4. Creates `crew.config.json` with your Windows name and this PC's name. An existing config is never changed.
5. Starts Crew and opens it in your browser.
6. Joins your hub, only if you pasted the line from the hub (it contains `-Hub` and `-Code`).
7. Turns on **autostart** (Windows asks for administrator approval once). Skip it with `-NoAutostart`.

**The one thing it can't do for you:** sign in to Claude Code. Type `claude` in a terminal once and follow the login. Crew uses that login.

If a step fails it stops and says what to do. Fix that, then run the same command again.

### Adding another PC, step by step

1. On the **hub** (the PC that is always on): open Crew → **🖥 Machines → Get pairing code**.
2. It shows a one-line command with the hub's address and a one-time code already filled in. Press **Copy**.
3. On the **new PC**: open PowerShell, paste, press Enter. Within a couple of minutes the new PC shows as online in the hub's Machines panel.
4. Sign in to Claude Code on the new PC (`claude`, once).

The hub only shows a one-line command if the new PC can reach it: turn on `"allowLan": true` for the same network, or set up Cloudflare for anywhere ([MACHINES.md](MACHINES.md)). The code works once and expires after 10 minutes. If it expires, press the button again.

### Manual install (Mac, Linux, or by hand)

The rest of this guide. Quick version:

1. `node --version` prints `v20` or higher. (Not installed? [Step C](#step-c-install-nodejs-and-git).)
2. `claude -p "Reply with exactly: Claude Code is working"` prints that sentence. (Not working? [Step D and E](#step-d-install-the-claude-code-command).)
3. `git clone https://github.com/hast3/claudecrew claudecrew`, then `cd claudecrew`.
4. Copy the config: `cp crew.config.example.json crew.config.json` (Windows cmd: `copy`). Set `"userName"` to your name.
5. `npm start`. Your browser opens at <http://localhost:7777>. Type `hello`.
6. To add or change agents, edit `crew.config.json`, restart Crew. See [Define your agents](#4-define-your-agents).

Stuck? See [What actually goes wrong](#what-actually-goes-wrong).

---

## Start here: never used Claude Code

### What Claude Code is

Claude Code is a program from Anthropic that lets Claude (the AI assistant) read, write and run things in a folder on your computer, such as fixing a bug in a project or tidying a set of notes. You normally use it by typing `claude` into a terminal. Claude Crew doesn't replace it. Crew is a chat page that starts Claude Code for you, once per "agent", each in its own folder. So Crew can only work if plain Claude Code already works on your computer. The steps below get you there.

### Words used in this guide

| Word | What it means |
| --- | --- |
| **Terminal** | A window where you type commands instead of clicking. Also called the command line or console. |
| **PowerShell** | The terminal that comes with Windows. This guide uses it on Windows. (Command Prompt, or `cmd`, is the older one. It also works for most steps.) |
| **Command** | One line you type in the terminal and run by pressing Enter. In this guide, commands are in grey boxes. Type or paste only the command, not any `#` comment after it. |
| **Repo** (repository) | A project folder tracked by Git, the program that records the history of a folder. "Clone the repo" means "download a copy of this project". |
| **Working folder** | The folder an agent works in. The agent can read and change files there. Pick folders you're happy for an AI to edit, and keep backups of anything precious. |
| **Config** | A settings file. Crew's is `crew.config.json`, a plain text file you edit in Notepad or any editor. |
| **Port** | A numbered door on your computer that a program listens on. Crew uses port `7777`, so its web address is `http://localhost:7777`. `localhost` means "this computer". |
| **PATH** | The list of folders your computer searches when you type a command name. "Command not found" usually means the program's folder isn't on it yet. |
| **Plan / subscription** | Your paid Claude account. Claude Code uses it, and Crew's work counts toward its usage limits. |

### Step A: a Claude account that can use Claude Code

Claude Code needs a paid Claude account. The free Claude.ai plan doesn't include it. Sign up or upgrade at <https://claude.ai> (look for the pricing or upgrade option). A **Pro** or **Max** subscription is the usual choice for individuals. Team and Enterprise plans, and an Anthropic Console account billed by API usage, also work. Plans and prices change, so check the current options on the website.

Crew runs on whichever account you log in with in step D. Several agents working at once use your plan's limits faster, so start small.

*What you should see:* after signing in on claude.ai you can chat with Claude in the browser, and your account page shows a plan other than "Free".

### Step B: open a terminal

- **Windows:** press the Windows key, type `PowerShell`, and press Enter. *You should see:* a window (usually dark blue or black) with a line ending in `>`, such as `PS C:\Users\YourName>`. That line is the **prompt**. It's waiting for you to type.
- **macOS:** press Cmd+Space, type `Terminal`, press Enter. *You should see:* a window with a prompt ending in `%` or `$`.
- **Linux:** open your "Terminal" app.

Everything below is typed here. Press **Enter** after each command and wait for the prompt to come back before the next one.

### Step C: install Node.js and Git

**Node.js** is the engine Crew itself runs on. **Git** downloads this project, and Crew uses it to show what each agent changed.

1. Node.js: download the **LTS** installer from <https://nodejs.org> and run it, accepting the defaults. Version **20 or newer** is required.
2. Git: download from <https://git-scm.com/downloads> and run the installer, accepting the defaults. (On Windows this is "Git for Windows". Claude Code on Windows also uses it.)
3. **Close your terminal and open a new one.** Terminals only notice newly installed programs when they start. Forgetting this is the most common reason for "command not found" right after installing.
4. Check both:
   ```
   node --version
   git --version
   ```
   *You should see:* two lines like `v22.11.0` and `git version 2.47.0.windows.1`. Your numbers will differ. For Node, anything from `v20` upwards is fine. If either says "not recognized" or "command not found", see [the error list](#if-you-see-this-error-do-this) below.

### Step D: install the Claude Code command

Anthropic's setup page has the current instructions: <https://docs.claude.com/en/docs/claude-code>. The usual way, at the time of writing:

- **Windows (PowerShell):**
  ```
  irm https://claude.ai/install.ps1 | iex
  ```
- **macOS / Linux:**
  ```
  curl -fsSL https://claude.ai/install.sh | bash
  ```
- **Alternative on any system, using Node:**
  ```
  npm install -g @anthropic-ai/claude-code
  ```

*You should see:* some download progress, then a message that Claude Code was installed. **Close the terminal and open a new one**, then check:

```
claude --version
```

*You should see:* a version number, probably followed by `(Claude Code)`.

### Step E: run `claude` once and log in

1. In your terminal, type `claude` and press Enter. (Run it from any folder for now. It may show a "trust this folder?" question, and if so, answer yes for a normal folder you own.)
2. The first time, it asks you to pick a theme, then to log in. Choose to log in with your **Claude account** (the subscription from step A).
3. Your web browser opens a Claude page. Sign in if asked and click **Authorize** (or similar). Then return to the terminal.

*What you should see:* in the terminal, a boxed welcome screen showing your account or plan, then a text box where you can type to Claude. Type `/exit` and press Enter (or press Ctrl+C twice) to leave.

If the login prompt never shows up later, run `claude auth login` to start it again.

### Step F: prove it works

Run this one-shot test. It asks Claude a question, prints the answer and exits:

```
claude -p "Reply with exactly: Claude Code is working"
```

*You should see:* after a few seconds, the single line `Claude Code is working` (or something very close), and then your prompt comes back.

If you got that, you've finished the hard part. **Crew uses exactly this login.** Carry on to [step 2](#2-get-the-code).

### If you see this error, do this

| What you see | What it means and what to do |
| --- | --- |
| `claude : The term 'claude' is not recognized…` (PowerShell) or `command not found: claude` / `'claude' is not recognized as an internal or external command` | The terminal can't find the program. 1) Close **all** terminal windows and open a new one. 2) If it still fails, the install folder isn't on your PATH. Re-run the installer and read its last lines, because it usually says where it put `claude` and how to add that folder to PATH. 3) Meanwhile you can set `claudePath` in the Crew config to the full path of the program (`where claude` on Windows or `which claude` elsewhere shows it, if it's found at all). |
| `node` or `git` "is not recognized" / "command not found" | Same cause. Close and reopen the terminal after installing. If it still fails, re-run the installer and make sure the option to add it to PATH is ticked. |
| PowerShell says **"running scripts is disabled on this system"** or **"cannot be loaded because running scripts is disabled"** after an `npm` install | PowerShell is blocking npm's launcher script. Don't weaken your system security for this. Use the **Command Prompt** (`cmd`) for that command instead, or use the installer in step D rather than npm. |
| `npm install -g` fails with `EACCES` or "permission denied" (macOS/Linux) | Don't use `sudo` with npm. Use the `curl` installer in step D instead, or follow npm's guide to set a user-owned global folder. |
| `claude --version` works but `claude` says **"Invalid API key"**, **"Please run /login"** or **"Not logged in"** | You're not logged in, or the login expired. Run `claude`, then type `/login` and follow the browser steps. Or run `claude auth login`. |
| **Login loop**: the browser says you're signed in, but the terminal keeps asking to log in | 1) Make sure you finished the browser step by clicking **Authorize**, not just signing in. 2) Check you're using the same Claude account that has the paid plan. 3) Run `claude auth logout`, then `claude auth login` again. 4) Try a different browser as your default, or copy the link the terminal shows into a browser you're already signed in to. 5) If you also have an `ANTHROPIC_API_KEY` environment variable set, remove it or log out of it. It can override your subscription login. |
| "Your plan doesn't include Claude Code", or a message about limits | The free plan can't use Claude Code. See step A. If you've hit your plan's usage limit, wait for it to reset. |
| `claude` asks **"Do you want to allow…?"** / permission prompts | Normal in the terminal. Claude Code asks before editing files or running commands, and you answer yes or no. **Crew can't answer these, since nobody is at the terminal.** Instead, Crew's `permissionMode` setting decides what agents may do on their own, and refused actions appear in the chat with an **Approve once and continue** button. See [step 3](#3-create-your-config). |
| `claude` asks **"Do you trust the files in this folder?"** | Answer yes for folders you own. Agents' folders need this answered once. The easiest way is to open a terminal in that folder, run `claude`, accept, and exit. |
| `claude -p …` hangs or prints nothing | Check your internet connection and any company proxy or VPN. Run plain `claude` to see a more detailed error message. |
| Anything else | Run `claude doctor` for a self-check, and see <https://docs.claude.com/en/docs/claude-code>. |

---

## 1. Prerequisites checklist

You should now have all of these. If one is missing, go back to the matching step above.

1. **Node.js 20+**: `node --version` prints `v20` or higher.
2. **Git** (optional but recommended): `git --version` prints a version. Crew uses it to show what each turn changed and to undo it.
3. **Claude Code CLI, logged in**: `claude -p "Reply with exactly: Claude Code is working"` prints the answer. Crew runs agents as *you*, with this login. If `claude` works in your terminal, it will work in Crew.

## 2. Get the code

```sh
git clone https://github.com/hast3/claudecrew claudecrew
cd claudecrew
```

**Got a zip file instead of using git?** Right-click it and choose **Extract All** (Mac: double-click it), pick a folder such as your Documents, then open a terminal in the extracted `claudecrew` folder (the one containing `server.js`). Windows: in File Explorer open that folder, click the address bar, type `cmd` and press Enter. Mac: right-click the folder, **New Terminal at Folder**. You should see `server.js` when you run `dir` (Windows) or `ls` (Mac/Linux).

There is nothing to install: Crew has no npm dependencies.

## 3. Create your config

```sh
cp crew.config.example.json crew.config.json      # Windows (cmd): copy crew.config.example.json crew.config.json
```

`crew.config.json` is git-ignored, so your paths and agents stay private. Open it and set:

- `settings.userName`: what agents call you.
- `settings.defaultAgent`: who gets messages with no `@mention`.
- The `agents` list (next step).

Other settings:

| Setting | Meaning |
| --- | --- |
| `port` | Web port (default `7777`). |
| `allowLan` | `true` lets phones and other PCs on your network connect (see step 6). |
| `maxHops` | How many agent-to-agent handoffs may happen in a row. `1` lets the coordinator hand off once. |
| `maxConcurrent` | How many agents may work at the same time. Keep it low to go easy on usage limits. |
| `permissionMode` | What agents may do with nobody at the terminal to approve. `auto` (default): edits and commands are allowed, and Claude Code's safety checks block risky actions. `acceptEdits`: file edits only, and commands not in `allowedTools` are refused. `manual`: read and answer only. `bypassPermissions`: anything. Use it only on a throwaway machine. |
| `model` | `null` = Sonnet by default, and the coordinator may pick Opus or Haiku per job. `"opus"`, `"sonnet"` or `"haiku"` forces one model for everyone. |
| `claudePath` | Full path to `claude` if it isn't on `PATH`. |
| `budget` | `enabled`, `fiveHour`, `weekly` (0–1). Above these usage levels, new work waits for the window to reset. |

Restart Crew after editing the config.

## 4. Define your agents

Each agent is one entry in `agents`:

```json
{
  "id": "webapp",
  "name": "WebApp",
  "emoji": "🛠️",
  "avatar": "tools",
  "cwd": "C:/Projects/my-web-app",
  "description": "Works on the my-web-app project: features, bug fixes and tests.",
  "instructions": "Run the test suite before you say a change is done. Commit locally only; never push."
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | The `@handle`. Lowercase letters, digits and `-`, starting with a letter. `all` is reserved. |
| `name` | | Display name (defaults to the id). |
| `cwd` | yes | The agent's working folder. Absolute, or relative to the Crew folder. Folders inside the Crew folder (such as `workspace/notes`) are created automatically. Folders outside it must already exist, or the agent shows as "folder not found". **Windows paths:** write forward slashes (`C:/Projects/app`) or doubled backslashes (`C:\\Projects\\app`). A single backslash makes the file invalid JSON. |
| `description` | | One line that teammates see, so they know what to hand this agent. |
| `instructions` | | Extra guidance for this agent only. Its project's own `CLAUDE.md` is still read as usual. |
| `emoji`, `avatar`, `color` | | Looks. `avatar` is one of `compass`, `castle`, `blueprint`, `swords`, `tools`, `house`. Anything else shows a gear. |
| `permissionMode`, `model` | | Per-agent overrides of the settings above. |
| `allowedTools`, `disallowedTools` | | Claude Code tool rules, e.g. `["Bash(npm test)"]`. |

**To add or change an agent:** there is no editor in the web page. Edit `crew.config.json`, then restart Crew (below). Add the new entry inside the `agents` list: put a comma between entries and **no comma after the last one**. After the restart, the new agent appears in the page. The terminal shows each agent and flags a missing folder. Chat history and sessions are kept across restarts.

**How to restart Crew:**

| How you started it | Restart |
| --- | --- |
| `npm start` or `node server.js` in a terminal | Click that terminal, press Ctrl+C, then run the same command again. |
| Tray icon / Start Crew.bat (Windows) | Right-click the tray icon, **Restart Crew**. |
| Autostart task (Windows) | `schtasks /run /tn "Claude Crew"`, or the tray icon's **Restart Crew**. |

**Single-agent setup.** Keep just one agent and make it the `defaultAgent`. Then you have a remote-friendly Claude Code chat for one project, with history, push, scheduling and undo. Handoffs simply never happen.

**Multi-agent setup.** Give each project its own agent, plus one coordinator (the example's `assistant`, working in `workspace/assistant`) as the `defaultAgent`. You say what you want, and the coordinator either answers or passes the job to the agent that owns the project. Each agent knows its teammates' ids, descriptions and folders. Tips:

- One agent per folder. Two agents editing the same repo at once will trip over each other.
- Write a sharp `description`. That line is how the coordinator decides who gets the work.
- Start with `maxConcurrent: 2` and `maxHops: 1`, and raise them once you trust the setup.

## 5. Start Crew

| How | When |
| --- | --- |
| `npm start` (= `node server.js --open`) | Any OS. Runs in the terminal and opens your browser. Ctrl+C stops it. |
| `node server.js` | Same, without opening a browser. |
| **Start Crew.bat** (Windows) | Double-click. Starts the tray icon, which starts Crew in the background and opens it. |
| `run-crew.cmd` (Windows) | Background runner with auto-restart. Logs to `data\crew.log`. Used by autostart. |

The console lists every agent and flags any whose folder is missing. Open <http://localhost:7777>.

**You should now see:** the page with your agents listed, a message box at the bottom, and no error banner. Type `hello`. The first reply can take up to a minute. Each agent's first message starts its own Claude Code session.

**To use a different port** for one run (for example if 7777 is taken), set `CREW_PORT` first. Each line below is for one shell:

```sh
CREW_PORT=7790 node server.js              # macOS / Linux
```
```powershell
$env:CREW_PORT = "7790"; node server.js    # Windows PowerShell
```
```bat
set CREW_PORT=7790 && node server.js       :: Windows cmd (no space before &&)
```

Then open `http://localhost:7790`. Or just change `"port"` in the config. To run a second, separate crew from the same code, also set `CREW_DATA_DIR` and `CREW_CONFIG` the same way.

## 6. Use it from your phone or another PC (LAN)

1. Set `"allowLan": true` and restart. Crew now listens on all network interfaces.
2. The console prints addresses like `http://192.168.x.x:7777` and an **access key**. Open the address on the phone and enter the key once. It's remembered in a cookie for a year. The key is stored in `data/state.json`. Delete it there and restart to rotate it.
3. Windows asks to let Node through the firewall. Allow it on **Private** networks only.
   - macOS: allow incoming connections for `node` when prompted.
   - Linux: open the port in `ufw` or `firewalld` if you use one.

Plain HTTP on your LAN is fine for chatting. Push notifications on a phone need HTTPS (next step).

## 7. Optional: HTTPS, push notifications and internet access

Crew has **no built-in TLS**. For HTTPS, put something in front of it:

- **Cloudflare Tunnel + Cloudflare Access (supported).** No open ports, with login and MFA handled by Cloudflare, and Crew also verifies the login token itself. Details below.
- **Your own reverse proxy** (Caddy, nginx, Tailscale Serve and so on), pointed at the local port. The local port trusts anything coming from the same machine. Only do this if the proxy enforces its own authentication, or keep it on your LAN and VPN.

### Push notifications (built in)

- Tap **🔔** in the page. The VAPID keys are generated automatically on first start and stored in `data/vapid.json`. Subscriptions go in `data/push-subscriptions.json`. Keep both private, and there is nothing to configure.
- Browsers only allow push on HTTPS or on `localhost`. On your PC, `http://localhost:7777` works. On a phone, use the HTTPS address.
- **iPhone/iPad:** open the HTTPS address in Safari, then choose **Share → Add to Home Screen**, open Crew from the home screen, and tap 🔔. iOS only allows web push for home-screen apps.
- **Android:** Chrome works directly. Installing to the home screen is optional.

### Cloudflare Tunnel (optional)

1. In Cloudflare Zero Trust, create a **Tunnel** (`cloudflared`) on this machine, and a public hostname such as `crew.example.com`.
2. Point the hostname's service at **`http://localhost:7778`**, the dedicated Cloudflare entrance. **Never point it at 7777.** The tunnel connects from this machine, and 7777 trusts local connections.
3. Create an **Access application** for that hostname with a policy that allows only your email(s). Copy its **Application Audience (AUD) Tag**.
4. Fill in the `cloudflare` block and restart:
   ```json
   "cloudflare": {
     "enabled": true,
     "hostname": "crew.example.com",
     "teamDomain": "myteam.cloudflareaccess.com",
     "aud": "<AUD tag>",
     "port": 7778,
     "allowedEmails": ["you@example.com"]
   }
   ```
   Crew checks every request's Access token itself: the RS256 signature against your team's keys, plus the `aud`, issuer, expiry, and that the email is in `allowedEmails`. A mistake on the Cloudflare side alone can't let a stranger in. Keep `allowedEmails` in step with the Access policy.

## 8. Optional: start automatically

**Windows.** The install command above already does this. To do it by hand, in an **Administrator** PowerShell, in the Crew folder:

```powershell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1              # install
powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall   # remove
```

`-ExecutionPolicy Bypass` applies to this one command only, and it doesn't change your system policy. This does two things:

- It registers a scheduled task, **Claude Crew**, that runs `run-crew.cmd` at boot, as you (S4U, with no stored password), even before you sign in. It restarts Crew if it exits.
- It adds a Startup-folder shortcut for the **tray icon**. The dot shows green when Crew is ready, amber while agents are working, and grey when Crew isn't running. Double-click to open Crew. Right-click for the log, restart, and reply notifications.

**macOS.** Not included yet. Create a `launchd` agent (`~/Library/LaunchAgents/…plist`) that runs `node /path/to/claudecrew/server.js` with `WorkingDirectory` set to the Crew folder and `KeepAlive` true.

**Linux.** Not included yet. Create a user systemd unit:

```ini
# ~/.config/systemd/user/claude-crew.service
[Unit]
Description=Claude Crew
[Service]
WorkingDirectory=%h/claudecrew
ExecStart=/usr/bin/node server.js
Restart=always
[Install]
WantedBy=default.target
```

Then run `systemctl --user enable --now claude-crew`, and `loginctl enable-linger $USER` to start it before login. Make sure `claude` is on that service's `PATH`, or set `CLAUDE_PATH`.

## Updating

Crew checks GitHub for a newer release when it starts and every 6 hours. It needs internet access and says nothing if it can't connect.

1. When one exists, a **⬆ Update available (vX)** button appears at the top of the page. It only shows when you open Crew on the PC it runs on, not from a phone.
2. Click it and confirm. *You should see:* the button change to "Updating…", then (if Crew was started with Start Crew.bat, the tray icon or autostart) "Restarting…" and the page reloading by itself. If you started Crew with `npm start`, you'll get a message saying it's updated: press Ctrl+C in the terminal and run `npm start` again.
3. Your `crew.config.json`, `data/`, `workspace/` and `.env` files are never changed.

How it updates: if the folder is a git clone, Crew fetches and fast-forwards to the release (and runs `npm install` only if dependencies changed). If you got a zip, Crew downloads the release zip and copies the files over yours. Zip installs need `tar` or `unzip` (both come with Windows 10+ and macOS).

If you edited the code yourself, a git update can refuse with a message about local changes. Commit or stash them first. Manual alternative for a clone: `git pull --ff-only`, then restart. For a zip, download the new zip, extract it over the old folder and keep your `crew.config.json` and `data/`.

## Windows-only pieces

| Piece | Windows | macOS / Linux |
| --- | --- | --- |
| `server.js`, `public/`, `lib/` | ✅ | ✅ Plain Node. |
| `npm start` / `node server.js` | ✅ | ✅ `--open` uses `open` / `xdg-open`. |
| `Start Crew.bat`, `run-crew.cmd` | ✅ | ❌ Use `npm start`, or a service as in step 8. |
| `crew-tray.ps1` (tray icon, balloon notifications) | ✅ | ❌ WinForms only. Use push notifications in the browser instead. |
| `install-autostart.ps1` | ✅ | ❌ Use launchd / systemd (step 8). |
| Reading user env vars from the registry at startup | ✅ | Skipped. Set environment variables in your shell or service file. |
| Finding `claude` | `where`, handles the `.cmd` shim | `which`. Or set `CLAUDE_PATH`. |

The macOS and Linux paths are expected to work but get less testing. Reports and fixes are welcome.

## Add-ons and integrations

Agents are ordinary Claude Code sessions in a folder, so anything Claude Code can do in that folder, an agent can do: MCP servers, the project's `CLAUDE.md`, scripts and so on.

- **Push notifications.** *Built in.* See step 7.
- **Telegram, Home Assistant and other services.** *Not built in.* A common pattern is an agent whose `cwd` is a project for that integration (a Telegram bot, Home Assistant scripts and so on). The agent works on it like any other project.
  - **Keep tokens out of `crew.config.json`.** Put them in environment variables or a git-ignored `.env` file in that project, and tell the agent where to find them in its `instructions`.
  - On Windows, user environment variables you set in System Properties reach agents even when Crew was started by the scheduled task.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CREW_CONFIG` | Config file path (default `crew.config.json`). |
| `CREW_DATA_DIR` | Data folder (default `data`). Use it to run a second, separate crew from the same code. |
| `CREW_PORT` | Overrides `settings.port`. |
| `CREW_USER_NAME` | Overrides `settings.userName`. |
| `CLAUDE_PATH` | Full path to the `claude` executable. |
| `NODE_EXE` | Node used by `run-crew.cmd`. |

## Where things are stored

`data/` holds the chat log (`messages.jsonl`; delete it to clear the history), each agent's session id, the access key, generated agent prompts, usage stats, schedules, uploads and the push keys. It's git-ignored. Back it up if you care about the history, and never publish it.

## What actually goes wrong

These were hit in a from-scratch trial run. The message is what Crew prints in the terminal ("Crew can't start: …").

| You see | Cause | Fix |
| --- | --- | --- |
| `No config at …crew.config.json` | You skipped the copy step, or you're in the wrong folder. | `cd` into the folder containing `server.js`, then copy `crew.config.example.json` to `crew.config.json`. |
| `crew.config.json is not valid JSON (…)` | A typo in the file. | Usual causes below. Paste the file into any JSON checker to find the line. |
| ...a comma after the last item in a list | `{ "id": "docs" },` as the final agent. | Delete the last comma. |
| ...a Windows path with single backslashes | `"cwd": "C:\Projects\app"` | Use `C:/Projects/app` or `C:\\Projects\\app`. |
| ...a missing quote or comma | Keys and text need `"double quotes"`, entries need commas between them. | Compare with `crew.config.example.json`. |
| `crew.config.json has no agents` | The `agents` list is empty or missing. | Add at least one agent. |
| Bad agent id | Ids are lowercase letters, digits and `-`, starting with a letter. `all` is reserved. | Rename it, for example `"My App"` becomes `"my-app"`. |
| `Two agents share the id "…"` | Copy-pasted an agent and didn't rename it. | Give each agent its own id. |
| `Port 7777 (…) is already in use` | Crew is already running (check the tray and other terminals), or another app has the port. | Close the other one, or use another port ([Start Crew](#5-start-crew)). |
| Agent shows "folder not found" | Its `cwd` is outside the Crew folder and doesn't exist. | Create the folder or fix the path, then restart. |
| `claude` is not recognized / ENOENT | Claude Code isn't installed, or isn't on `PATH` for this terminal. | Close and reopen the terminal. Otherwise set `claudePath` ([Troubleshooting](#troubleshooting)). |
| `node` is not recognized | Node.js isn't installed, or the terminal was opened before installing. | Install Node ([Step C](#step-c-install-nodejs-and-git)), then open a new terminal. |
| Page won't load | Crew isn't running, or you used the wrong port. | Look at the terminal for the printed address. |
| Edits to the config have no effect | Crew reads the config only at start. | Restart ([how](#4-define-your-agents)). |
| Reply never arrives | Claude Code isn't logged in for this user, or your plan's usage limit is reached. | Run `claude -p "hi"` in a terminal and see what it says. |

## Troubleshooting

- **"No config at …"**: copy `crew.config.example.json` to `crew.config.json`.
- **Agents reply with a login or auth error**: run `claude auth login` in a terminal, as the same user Crew runs as.
- **Agents fail to start** (the console's `Claude Code:` line shows the wrong path, or the error mentions `ENOENT`): set `settings.claudePath` or `CLAUDE_PATH` to the full path (`where claude` on Windows, `which claude` elsewhere).
- **"My folder doesn't exist"**: fix that agent's `cwd`. Folders outside the Crew folder are not created for you.
- **Port already in use**: another Crew (or another app) is on 7777. Change `port`, or set `CREW_PORT`.
- **Phone can't connect**: check that `allowLan` is `true`, Crew was restarted, the phone is on the same network, the firewall allows Node on Private networks, and you're using the PC's LAN address, not `localhost`.
- **No push on iPhone**: you need HTTPS and the home-screen app (step 7).
- **Agents keep getting refused**: the `permissionMode` is stricter than the task needs. Use **Approve once and continue** on the reply, add specific `allowedTools`, or loosen the mode for that agent.
- **Work is "held"**: the budget guard is active. Wait for the reset, use **Run anyway**, or change the levels in the usage panel.
- **Background Crew on Windows**: look at `data\crew.log` (the tray icon has **View log**). To restart, use the tray icon's **Restart Crew**, or run `schtasks /run /tn "Claude Crew"`.
