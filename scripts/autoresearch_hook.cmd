@echo off
node.exe "%~dp0hook.mjs" %*
exit /b %errorlevel%
