@echo off
setlocal EnableExtensions
title Private Chat update

REM cmd.exe reads a batch file from disk as it runs it, so an update that
REM replaces this very file would make execution jump into the new one midway.
REM Work from a copy in the temp folder, which the pull cannot touch.
if /i not "%~1"=="/worker" (
  copy /y "%~f0" "%TEMP%\private-chat-update.cmd" >nul
  if errorlevel 1 (
    echo Could not stage the updater in the temp folder.
    pause
    exit /b 1
  )
  "%TEMP%\private-chat-update.cmd" /worker "%~dp0"
  exit /b %errorlevel%
)

set "ROOT=%~2"
cd /d "%ROOT%"

where git >nul 2>&1
if errorlevel 1 (
  echo Git is not installed, so this copy cannot update itself.
  echo Install it from https://git-scm.com/download/win and run this file again.
  pause
  exit /b 1
)

if not exist ".git" (
  echo This folder is not a git clone, so there is nothing to pull.
  echo Clone it instead: git clone https://github.com/freelanceontime/PrivacyFilter.git
  pause
  exit /b 1
)

for /f "delims=" %%R in ('git rev-parse HEAD') do set "BEFORE=%%R"

echo Fetching the latest version...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo The update did not apply cleanly. If this copy has local edits, keep them
  echo with: git stash  then run this file again.
  pause
  exit /b 1
)

for /f "delims=" %%R in ('git rev-parse HEAD') do set "AFTER=%%R"
if "%BEFORE%"=="%AFTER%" (
  echo.
  echo Already up to date. Nothing to restart.
  pause
  exit /b 0
)

REM Only a change to the Python side needs the server restarted. Page and
REM extension changes are picked up by reloading, which costs nothing.
set "RESTART="
set "EXTENSION="
set "PAGE="
git diff --quiet %BEFORE% %AFTER% -- "*.py" "*.pyw" requirements.txt config.example.json || set "RESTART=1"
git diff --quiet %BEFORE% %AFTER% -- extension || set "EXTENSION=1"
git diff --quiet %BEFORE% %AFTER% -- static || set "PAGE=1"

echo.
echo Checking prerequisites...
call "%ROOT%Start Private Chat.cmd" /check < nul >nul
if errorlevel 1 (
  echo Setup failed. Run "Start Private Chat.cmd /check" in the folder to see why.
  pause
  exit /b 1
)

if defined RESTART (
  echo Restarting the local service. Chats held in this session are cleared.
  call :stop
  start "Private Chat" "%ROOT%.venv\Scripts\pythonw.exe" "%ROOT%launch.pyw"
  echo Restarted.
) else (
  echo The local service is unchanged and keeps running.
)

if defined PAGE echo Reload the Private Chat page to pick up the new interface.
if defined EXTENSION echo Reload the companion at chrome://extensions to pick up the new extension.
echo.
pause
exit /b 0

:stop
REM Stop whatever holds the app's port, so the new instance can bind it.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"TCP *127.0.0.1:8787 .*LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
)
REM Give the socket a moment to be released before rebinding it.
ping -n 3 127.0.0.1 >nul
exit /b 0
