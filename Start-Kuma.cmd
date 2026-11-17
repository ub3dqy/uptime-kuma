@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
set "KUMA_PORT=3001"
set "KUMA_DATA_SOURCE=kuma_data"

if exist "data\kuma.db" goto existing
if exist "data\db-config.json" goto existing
set "KUMA_DOCKER_MAJOR="
for /f "tokens=1 delims=." %%V in ('docker version --format "{{.Server.Version}}" 2^>nul') do set "KUMA_DOCKER_MAJOR=%%V"
if not defined KUMA_DOCKER_MAJOR goto docker
if %KUMA_DOCKER_MAJOR% LSS 28 goto upgrade
docker compose version >nul 2>&1
if errorlevel 1 goto docker

echo Готовим Uptime Kuma от ub3dqy. При первом запуске загрузка может занять несколько минут.
docker compose -p kuma-ub3dqy -f compose.yaml up -d --build --wait --wait-timeout 180
if errorlevel 1 goto failed
set "KUMA_OPEN_URL="
for /f "delims=" %%U in ('docker compose -p kuma-ub3dqy -f compose.yaml exec -T uptime-kuma node extra/first-run-url.cjs 3001') do set "KUMA_OPEN_URL=%%U"
if not defined KUMA_OPEN_URL goto failed
start "" "%KUMA_OPEN_URL%"
popd
exit /b 0

:existing
echo Здесь уже есть данные Uptime Kuma. Откройте docs\FIRST-STEPS.ru.md и выберите раздел «Перенос существующей установки».
goto stop
:docker
echo Откройте Docker Desktop, дождитесь его запуска и снова откройте Start-Kuma.cmd.
goto stop
:upgrade
echo Обновите Docker Desktop. Для безопасного локального запуска нужен Docker Engine 28 или новее.
goto stop
:failed
echo Запуск не завершился. Проверьте свободное место, доступ в интернет и порт 3001. См. docs\FIRST-STEPS.ru.md.
:stop
pause
popd
exit /b 1
