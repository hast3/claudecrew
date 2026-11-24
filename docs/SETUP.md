# Setting up Claude Crew (Windows)

This takes about 10 minutes. You do not need to know anything about computers. You do not need administrator rights.

**What you need first:** a paid Claude account (Pro or Max). Free accounts do not work. Get one at https://claude.ai.

## The 5 steps

Take your time. Nothing you click here can break your computer, and you can start over at any point by double-clicking INSTALL.bat again. The installer explains each question as it asks it, and tells you when to wait. It takes 5 to 15 minutes, and a window that looks stuck is almost always just working.

1. **Download.** On the GitHub page, click the green **Code** button, then **Download ZIP**.
2. **Extract.** Open your Downloads folder, right-click the zip file and choose **Extract All**, then click **Extract**. A new folder opens. (Do not skip this: it will not work from inside the zip.)
3. **Install.** In the new folder, double-click **INSTALL.bat**. If Windows shows a blue box saying "Windows protected your PC", click **More info**, then **Run anyway**.
4. **Answer the questions.** A black window asks a few things. Press **Enter** to accept the answer shown in [brackets].
   - *What is your first name?* Crew calls you this.
   - *Use Crew from your phone on the same Wi-Fi?* Say **y** if you want that.
   - *Start Crew when you sign in to Windows?* Usually **y**.
   - *Folder for a helper to work in?* Paste a folder path (for example, copy it from the File Explorer address bar) if you want a helper for one of your projects. Press Enter to skip. You can add more later.
5. **Sign in when asked.** If a browser page opens asking you to sign in to Claude, do it and click **Authorize**. Then wait. When you see **ALL DONE**, Crew opens in your browser.

That is it. Next time, double-click the **Claude Crew** icon on your Desktop. Type **hello** in the chat. The first reply can take a minute.

You can run INSTALL.bat again whenever you like. It never deletes your settings or chat history.

## If something goes wrong

The installer tells you what to do on screen. These are the common ones.

| What you see | What to do |
|---|---|
| "Windows protected your PC" | Click **More info**, then **Run anyway**. |
| The window closes instantly, or says it cannot see its files | You ran it from inside the zip. Extract the zip first (step 2). |
| "Node.js is still missing" | Go to https://nodejs.org, click the big **LTS** button, run it, accept the defaults, then run INSTALL.bat again. On a work laptop, ask IT to allow it. |
| "Git is still missing" | Go to https://git-scm.com/download/win, run it, accept the defaults, then run INSTALL.bat again. |
| Downloads fail on a work network | Your work uses a proxy or firewall. Try again at home or on a phone hotspot. Or ask IT to allow nodejs.org, github.com and claude.ai. |
| Antivirus blocks it | Ask IT to allow the Crew folder, or install on a personal computer. |
| "Claude Code is not answering" or the sign-in keeps asking again | You need a paid Claude plan (Pro or Max). Check you are signed in at https://claude.ai with that account. Then open PowerShell, type `claude`, press Enter and follow the sign-in. |
| The page does not open | Open your browser and go to http://localhost:7777. |
| Anything else | Send the file **install-log.txt** (in the Crew folder) to whoever is helping you. |

## Changing things later

- **Add more helpers (agents):** open the settings file `crew.config.json` in the Crew folder with Notepad, or ask your Assistant in the chat to do it.
- **Mac or Linux, or doing it by hand:** see [SETUP-ADVANCED.md](SETUP-ADVANCED.md).
- **Several PCs on one crew:** see [MACHINES.md](MACHINES.md).
