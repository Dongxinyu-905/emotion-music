@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8123

echo ==========================================================
echo   MoodTune  -  Emotion Music Recommender
echo.
echo   URL :  http://127.0.0.1:%PORT%/
echo   NOTE:  Keep this window open while using the app.
echo          Close it to stop the server.
echo ==========================================================
echo.

rem --- already running? just open the browser ---
netstat -ano | findstr ":%PORT%" | findstr LISTENING >nul 2>nul
if not errorlevel 1 (
  echo Server already running on port %PORT%, opening browser...
  start http://127.0.0.1:%PORT%/
  timeout /t 2 >nul
  exit /b 0
)

rem --- locate python ---
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py -3" )
if not defined PY if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not defined PY if exist "C:\ProgramData\miniconda3\python.exe" set "PY=C:\ProgramData\miniconda3\python.exe"

if not defined PY (
  echo [ERROR] Python 3 not found.
  echo         Install from https://www.python.org/downloads/
  echo         and tick "Add python.exe to PATH".
  pause
  exit /b 1
)

start "" /min cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%/"

%PY% -m http.server %PORT% --bind 127.0.0.1

echo.
echo Server stopped.
pause
