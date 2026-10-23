@echo off
rem Runs Crew in the background (used by the "Claude Crew" scheduled task).
rem Output goes to data\crew.log. If Crew ever exits, it restarts after 10 seconds.
cd /d "%~dp0"
if not exist data mkdir data
rem Node: NODE_EXE if set, else the first node.exe on PATH, else the default install folder.
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

:loop
for %%F in (data\crew.log) do if %%~zF GTR 5000000 move /y data\crew.log data\crew.old.log >nul
echo.>> data\crew.log
echo ===== Crew starting %date% %time% =====>> data\crew.log
"%NODE_EXE%" server.js >> data\crew.log 2>&1
echo ===== Crew exited with code %errorlevel% at %date% %time%; restarting in 10 seconds =====>> data\crew.log
timeout /t 10 /nobreak >nul
goto loop
