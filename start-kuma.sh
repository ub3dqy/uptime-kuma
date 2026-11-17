#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ -e data/kuma.db || -e data/db-config.json ]]; then
    printf '%s\n' 'Здесь уже есть данные. См. «Перенос существующей установки» в docs/FIRST-STEPS.ru.md.' >&2
    exit 1
fi

if ! docker_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' 'Запустите Docker с дополнением Compose, затем повторите команду.' >&2
    exit 1
fi

docker_major=${docker_version%%.*}
if [[ ! $docker_major =~ ^[0-9]+$ ]] || ((docker_major < 28)); then
    printf '%s\n' 'Для безопасного локального запуска нужен Docker Engine 28 или новее.' >&2
    exit 1
fi

export KUMA_DATA_SOURCE=kuma_data
export KUMA_PORT="${KUMA_PORT:-3001}"
compose=(docker compose -p kuma-ub3dqy -f compose.yaml)
printf '%s\n' 'Готовим Uptime Kuma от ub3dqy. При первом запуске загрузка может занять несколько минут.'
if ! "${compose[@]}" up -d --build --wait --wait-timeout 180; then
    printf '%s\n' 'Запуск не завершился. См. раздел о запуске в docs/FIRST-STEPS.ru.md.' >&2
    exit 1
fi
url=$("${compose[@]}" exec -T uptime-kuma node extra/first-run-url.cjs "$KUMA_PORT")
printf 'Откройте в браузере на этом компьютере: %s\n' "$url"
