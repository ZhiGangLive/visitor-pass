@echo off
chcp 65001 >nul
title 访客邀请函通行系统
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] 没有找到 Node.js
  echo.
  echo       请先安装 Node.js 16 或更高版本：https://nodejs.org/
  echo       安装完重新双击本文件即可，不需要 npm install。
  echo.
  pause
  exit /b 1
)

if not exist data mkdir data

echo.
echo   正在启动访客通行系统...
echo   关闭这个窗口就会停止服务。
echo.

node server.js

echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
