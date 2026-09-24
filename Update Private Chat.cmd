@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Private Chat update

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

REM Local settings stay out of the repository, so a pull never overwrites them.
echo Fetching the latest version...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo The update did not apply cleanly. If this copy has local edits, keep them
  echo with: git stash  then run this file again.
  pause
  exit /b 1
)

echo.
echo Checking prerequisites...
call "%~dp0Start Private Chat.cmd" /check

echo Reload the Chrome companion at chrome://extensions to pick up extension changes.
pause
exit /b 0
