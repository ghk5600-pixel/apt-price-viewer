@echo off
set "ROOT=%~dp0"
set "PYTHON=C:\Users\gs\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
echo Apartment dashboard is running at http://localhost:8080
echo Close this window to stop the local server.
echo.
"%PYTHON%" -m http.server 8080 -d "%ROOT%."
