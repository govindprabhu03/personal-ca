@echo off
title Personal CA
cd /d %~dp0server
if exist ..\release\PersonalCA.exe (start "" "..\release\PersonalCA.exe") else (if not exist node_modules npm install & npm run phone)
