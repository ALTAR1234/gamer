@echo off
rem Double-click to launch Gamer.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
