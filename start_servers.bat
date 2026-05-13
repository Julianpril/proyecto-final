@echo off
echo ========================================================
echo   Iniciando Proyecto Final - Sistemas Distribuidos
echo ========================================================
echo.

echo Cerrando procesos anteriores en puertos 3000, 4000 y 5000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
timeout /t 2 /nobreak >nul

if not defined JWT_SECRET set "JWT_SECRET=dev-secret"

echo Iniciando Auth Service (4000), Coordinator (5000) y Cliente (3000)...
echo (Presiona Ctrl+C en cualquier momento para detener todos)
echo.

pushd "%~dp0"
npm start
popd
