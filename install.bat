@echo off
rem Geekatplay Photoshop Bridge - Windows installer
rem by Geekatplay Studio - Vladimir Chopine - https://www.geekatplay.com
rem Double-click to install the ComfyUI nodes and the Photoshop panel.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
