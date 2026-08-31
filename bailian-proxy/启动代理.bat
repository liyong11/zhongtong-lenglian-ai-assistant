@echo off
chcp 65001 >nul
title 中通冷链 AI 助理 · 百炼代理
cd /d "%~dp0"
echo 正在启动百炼代理服务器...
start "" http://localhost:8787/
node server.js
pause
