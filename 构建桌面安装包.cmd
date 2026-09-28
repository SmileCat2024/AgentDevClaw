@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node scripts\build-desktop-installer.mjs %*
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
  echo Build finished. Installer is under desktop\target\release\bundle\nsis\
) else (
  echo Build FAILED. Staging and desktop exe remain available; see the retry command above.
)
echo.
pause
exit /b %RESULT%
