@echo off
title DL-TerrainMapper - server (close this window to stop)
cd /d "%~dp0"

rem This file sits BESIDE project\, not inside it, so the path to the launcher
rem is explicit. launcher.py resolves its own folder rather than the working
rem directory (ROOT = Path(__file__).resolve().parent), so it serves the app
rem correctly wherever it is started from.
rem
rem Standard library only - no venv, no npm, nothing to install. Given no
rem --port it takes the first free one from 8990 upward and opens the browser
rem itself, so a stale window still holding the port cannot stop it starting.
rem
rem   start.bat                      the tool
rem   start.bat test                 the check suite, 126 checks (needs Node)
rem   start.bat --port 9100          bind that port exactly, or fail
rem   start.bat --no-browser
rem
rem The suite is the honest gate before anything is cut: it asserts the
rem properties the machine depends on - contours leaving as continuous paths,
rem the DXF staying ASCII with no exponents, the six DLF pass layers matching
rem DL-TerrainSlicer exactly, and a licence-restricted image refusing to export.

if /i "%~1"=="test" goto :tests
if /i "%~1"=="tests" goto :tests

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on your PATH.
  echo Install Python 3 from https://www.python.org/downloads/ and try again.
  echo.
  pause
  exit /b 1
)

python "project\launcher.py" %*
if errorlevel 1 (
  echo.
  echo The server stopped with an error. The message above says why.
  pause
  exit /b 1
)
pause
exit /b 0

:tests
where node >nul 2>nul
if errorlevel 1 (
  echo Node was not found on your PATH - it is needed only for the checks,
  echo not for the tool itself.
  echo Install Node from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)
pushd "project"
node "tests\selftest.mjs"
set SUITE=%errorlevel%
popd
echo.
if not "%SUITE%"=="0" (
  echo CHECKS FAILED - do not cut anything from this build until they pass.
) else (
  echo All checks passed.
)
pause
exit /b %SUITE%
