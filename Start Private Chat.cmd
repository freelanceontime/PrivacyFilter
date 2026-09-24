@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Private Chat
set "CHECK_ONLY="
if /i "%~1"=="/check" set "CHECK_ONLY=1"

REM ---------------------------------------------------------------- Python ---
REM A copied folder may arrive on a machine with no Python at all, so find a
REM usable interpreter first and offer to install one before anything else.
set "PY="
py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"

if not defined PY (
  echo Python 3.10 or later was not found on this machine.
  where winget >nul 2>&1
  if errorlevel 1 goto :no_python
  echo Installing Python with winget. Approve the prompt if Windows asks.
  winget install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements
  py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=py -3"
  if not defined PY python -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1 && set "PY=python"
  if not defined PY (
    echo Python was installed but this window cannot see it yet.
    echo Close this window, open a new one, and run this file again.
    pause
    exit /b 1
  )
)

REM ------------------------------------------------------------ Environment ---
REM A .venv copied from another machine points at an interpreter that is not
REM here, so prove it works and rebuild it when it does not.
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import flask,waitress" >nul 2>&1
  if errorlevel 1 (
    echo Rebuilding the Python environment for this machine...
    rmdir /s /q ".venv"
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating a private Python environment...
  %PY% -m venv .venv
  if errorlevel 1 goto :venv_failed
)

".venv\Scripts\python.exe" -c "import flask,waitress" >nul 2>&1
if errorlevel 1 (
  echo Installing Flask and waitress...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
  if errorlevel 1 goto :pip_failed
)

".venv\Scripts\python.exe" -c "import flask,waitress" >nul 2>&1
if errorlevel 1 goto :pip_failed

REM ---------------------------------------------------------------- Report ----
REM Relative path, so spaces in the folder above this one cannot break it.
for /f "delims=" %%V in ('.venv\Scripts\python.exe -c "import sys;print(sys.version.split()[0])"') do set "PYVER=%%V"
echo Python %PYVER% and dependencies are ready.
echo.
echo Filtering model: set in config.json, checked from Settings inside the app.
echo Chrome companion: load "%~dp0extension" at chrome://extensions with
echo   Developer mode on, then reload the Private Chat page.
echo.

if defined CHECK_ONLY (
  echo Prerequisites are in place. Run this file without /check to start.
  pause
  exit /b 0
)

start "Private Chat" ".venv\Scripts\pythonw.exe" "%~dp0launch.pyw"
exit /b 0

:no_python
echo.
echo Install Python 3.10 or later from https://www.python.org/downloads/windows/
echo Tick "Add python.exe to PATH" and "py launcher" during setup, then run this file again.
pause
exit /b 1

:venv_failed
echo.
echo Could not create the Python environment in this folder.
echo Copy the folder somewhere you can write to, such as the Desktop, and try again.
pause
exit /b 1

:pip_failed
echo.
echo Could not install Flask and waitress. This step needs internet access once.
echo If this machine is offline, copy the .venv folder from a machine with the
echo same Python version, or run: .venv\Scripts\python.exe -m pip install -r requirements.txt
pause
exit /b 1
