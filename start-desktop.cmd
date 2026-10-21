@echo off
cd /d "%~dp0"
if exist "release\win-unpacked\BranchLocal.exe" (
  start "" "release\win-unpacked\BranchLocal.exe"
  exit /b 0
)
call start-local.cmd
