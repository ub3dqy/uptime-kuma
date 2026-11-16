const strings = require("../../src/lang/ru-RU.json");
const { observationTime } = require("../../src/overview-state.ts");
const { durations, actions } = require("./monitors");

const states = {
    up: "🟢 Работает",
    down: "🔴 Сбой",
    pending: "🟠 Повторная проверка",
    maintenance: "🔧 Техработы",
    paused: "⏸ На паузе",
    unknown: "⚪ Нет свежих данных",
};
const checks = ["down", "up", "pending", "maintenance"];
const actionTitles = {
    pause: "Поставить на паузу",
    resume: "Возобновить проверки",
    maintenance: "Начать техработы",
    end: "Завершить техработы",
    aiDiagnosis: "Запустить диагностику ИИ",
    aiCancel: "Отменить запрос ИИ",
};
const journalTitles = {
    [actions.pause]: "Пауза проверки",
    [actions.resume]: "Возобновление проверки",
    [actions.maintenance]: "Начало техработ",
    [actions.end]: "Завершение техработ",
};
const deliveryStates = {
    queued: strings.stage2DeliveryQueued,
    sending: strings.stage2DeliverySending,
    submitted: strings.stage2DeliverySubmitted,
    failed: strings.stage2DeliveryFailed,
    uncertain: strings.stage2DeliveryUncertain,
    cancelled: strings.stage2DeliveryCancelled,
};
const aiStates = {
    off: "Не подключён",
    saved: "Требуется проверка подключения",
    verified: "Подключён",
    expired: strings.projectAIState_expired,
    limited: strings.projectAIState_limited,
};
const automaticStates = {
    off: "Выключена",
    active: "Включена для выбранных мониторов",
    needsReview: "Требуется проверить настройки в панели",
};

/**
 * @param {unknown} value Display text from a monitor or a channel
 * @param {number} length Maximum display length
 * @returns {string} Bounded one-line text
 */
function label(value, length = 85) {
    const text = String(value ?? "")
        .replace(/[\p{Cc}\p{Bidi_Control}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const chars = Array.from(text);
    return chars.length <= length ? text : chars.slice(0, length - 1).join("") + "…";
}

/**
 * @param {string|number} value UTC timestamp or saved observation time
 * @param {string} zone Project timezone
 * @returns {string} Display time with offset
 */
function when(value, zone) {
    const time = typeof value === "number" ? value : observationTime(value);
    if (time === null || !Number.isFinite(time)) {
        return "—";
    }
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: zone,
        dateStyle: "short",
        timeStyle: "short",
    }).format(time);
}

/**
 * @param {string} text Button title
 * @param {string} data Closed callback
 * @returns {object} Telegram inline button
 */
function button(text, data) {
    return { text, callback_data: data };
}

const home = () => button("← Меню", "home");
const monitorButton = (id) => button("← Монитор", `monitor:${id}`);

/**
 * @param {string[]} lines Text lines
 * @param {object[][]} rows Inline button rows
 * @returns {object} Plain Telegram reply with forwarding disabled
 */
function reply(lines, rows = []) {
    return {
        text: lines.filter((line) => line !== null).join("\n"),
        reply_markup: { inline_keyboard: rows },
        protect_content: true,
        link_preview_options: { is_disabled: true },
    };
}

/**
 * @param {object} result Current project's summary
 * @returns {object} Main menu
 */
function summary(result) {
    const { name, counts, timezone } = result;
    return reply(
        [
            label(name),
            "",
            ...Object.entries(states).map(([key, title]) => `${title} · ${counts[key]}`),
            "",
            `Время · ${timezone}`,
        ],
        [
            [button("Мониторы", "list:all:0"), button("Сбои", "list:issues:0")],
            [button("На паузе", "list:paused:0"), button("Техработы", "windows")],
            [button("Сертификаты", "cert:0"), button("Уведомления", "deliveries")],
            [button("Поиск", "search"), button("Журнал действий", "journal")],
            [button("Личный ИИ", "ai")],
            [button("Обновить сводку", "home")],
        ]
    );
}

/**
 * @param {object} result Page metadata
 * @param {Function} route Callback for a given page
 * @returns {object[]} Available pagination buttons
 */
function pages(result, route) {
    const { page, lastPage } = result;
    const row = [];
    if (page > 0) {
        row.push(button("‹ Назад", route(page - 1)));
    }
    if (page < lastPage) {
        row.push(button("Дальше ›", route(page + 1)));
    }
    return row;
}

/**
 * @param {object} result Monitor page
 * @param {string} title List or search title
 * @param {Function} route Callback for a given page
 * @returns {object} Monitor selection
 */
function monitors(result, title, route) {
    const rows = result.monitors.map(({ id, name, state }) => [
        button(`${states[state].split(" ")[0]} ${label(name, 43) || "#" + id}`, `monitor:${id}`),
    ]);
    const navigation = pages(result, route);
    if (navigation.length) {
        rows.push(navigation);
    }
    rows.push([home()]);
    return reply(
        [
            title,
            result.total
                ? `Найдено ${result.total} · страница ${result.page + 1} из ${result.lastPage + 1}`
                : "Подходящих мониторов пока нет.",
        ],
        rows
    );
}

/**
 * @param {object} monitor Current monitor evidence
 * @returns {object} Monitor card and controls
 */
function detail(monitor) {
    const { id, name, host, state, checkedAt, ping, explanation, confirmedAt, limited, lastGood, timezone, window } =
        monitor;
    const rows = [[button("История", `history:${id}`), button("Отчёт за сутки", `report:${id}`)]];
    rows.push([button("Диагностика ИИ", `ai-check:${id}`)]);
    if (monitor.canControl) {
        if (monitor.active) {
            rows.push([button("⏸ Пауза", `prepare:pause:${id}`)]);
            if (!monitor.parentPaused && !window && state !== "maintenance") {
                rows.push([button("🔧 Начать техработы", `durations:${id}`)]);
            }
        } else if (!monitor.parentPaused) {
            rows.push([button("▶ Возобновить", `prepare:resume:${id}`)]);
        }
        if (window) {
            rows.push([button("Завершить техработы", `prepare:end:${id}:${window.id}`)]);
        }
    }
    if (monitor.url) {
        rows.push([{ text: "Открыть в панели", url: monitor.url }]);
    }
    rows.push([button("Обновить", `monitor:${id}`), home()]);
    return reply(
        [
            `${label(name) || "Монитор"} · #${id}`,
            host || null,
            "",
            states[state],
            `Последняя проверка · ${when(checkedAt, timezone)}`,
            state === "up" && typeof ping === "number" && ping >= 0 ? `Отклик · ${Math.round(ping)} мс` : null,
            ["down", "pending", "unknown"].includes(state) ? strings[explanation] : null,
            state === "pending" && monitor.lastError
                ? `Последняя сохранённая ошибка · ${strings[monitor.lastError + "Short"] || strings[monitor.lastError]}`
                : null,
            state === "down" && confirmedAt
                ? `${limited ? "Сбой виден в истории с" : "Первый подтверждённый сбой"} · ${when(confirmedAt, timezone)}`
                : null,
            state === "down" && lastGood ? `Последняя успешная проверка · ${when(lastGood, timezone)}` : null,
            monitor.parentPaused ? "Родительская группа на паузе." : null,
            window ? `Техработы из Telegram до ${when(window.end, timezone)}.` : null,
            `Время · ${timezone}`,
        ],
        rows
    );
}

/**
 * @param {object} monitor Saved observations
 * @returns {object} Recent check results
 */
function history(monitor) {
    const { id, name, recent, timezone } = monitor;
    const rows = recent.map((entry) => {
        const title = states[checks[entry.status]] ?? states.unknown;
        const ping =
            entry.status === 1 && typeof entry.ping === "number" && entry.ping >= 0
                ? ` · ${Math.round(entry.ping)} мс`
                : "";
        return `${when(entry.time, timezone)} · ${title}${ping}`;
    });
    return reply(
        [
            `Последние проверки · ${label(name)}`,
            "",
            ...(rows.length ? rows : ["Сохранённых проверок пока нет."]),
            "",
            `Время · ${timezone}`,
        ],
        [[monitorButton(id), home()]]
    );
}

/**
 * @param {object} data Period summary
 * @param {number} id Monitor ID
 * @returns {object} Availability based on observed time and coverage
 */
function report(data, id) {
    const percent = (value) =>
        value === null
            ? "—"
            : new Intl.NumberFormat("ru-RU", { style: "percent", maximumFractionDigits: 2 }).format(value);
    return reply(
        [
            `Отчёт за 24 часа · ${label(data.name)}`,
            "",
            `Доступность по наблюдениям · ${percent(data.availability)}`,
            `Доля времени с данными · ${percent(data.coverage)}`,
            `Успешных проверок · ${data.counts.up} из ${data.counts.total}`,
            `Проверок со сбоем · ${data.counts.down}`,
            `Повторных проверок · ${data.counts.pending}`,
            `Проверок в техработах · ${data.counts.maintenance}`,
            data.response.mean === null ? null : `Средний отклик · ${Math.round(data.response.mean)} мс`,
        ],
        [[monitorButton(id), home()]]
    );
}

/**
 * @param {object} result Certificate page
 * @returns {object} Stored certificate expiry dates
 */
function certificates(result) {
    const rows = result.certificates.map(({ id, name }) => [button(label(name, 43) || "#" + id, `monitor:${id}`)]);
    const navigation = pages(result, (page) => `cert:${page}`);
    if (navigation.length) {
        rows.push(navigation);
    }
    rows.push([home()]);
    const now = Date.now();
    return reply(
        [
            "Сохранённые сроки сертификатов",
            "",
            ...result.certificates.map(({ name, host, end }) => {
                const days = Math.ceil((end - now) / 86400000);
                return `${label(name) || host} · ${when(end, result.timezone)} · ${end <= now ? "истёк" : `${days} дн.`}`;
            }),
            result.certificates.length ? null : "Сроки сертификатов пока не сохранены.",
            "",
            `Время · ${result.timezone}`,
        ],
        rows
    );
}

/**
 * @param {object} result Managed channel delivery records
 * @returns {object} Delivery journal
 */
function deliveries(result) {
    const { rows, timezone } = result;
    return reply(
        [
            "Последние отправки уведомлений",
            "",
            ...rows.map(
                (row) =>
                    `${when(Number(row.updated_at), timezone)} · ${label(row.name)}\n${row.confirmed_at ? strings.stage2DeliveryConfirmed : deliveryStates[row.status] || "Статус неизвестен"}`
            ),
            rows.length ? null : "В журнале пока нет записей.",
            "",
            `Время · ${timezone}`,
        ],
        [[button("Обновить", "deliveries"), home()]]
    );
}

/**
 * @param {object} result Active maintenance started in Telegram
 * @returns {object} Current windows and buttons for their monitors
 */
function windows(result) {
    const { rows, timezone } = result;
    return reply(
        [
            "Активные техработы из Telegram",
            "",
            ...rows.map((row) => `${label(row.name)} · до ${when(row.end, timezone)}`),
            rows.length ? null : "Сейчас таких техработ нет.",
            "",
            `Время · ${timezone}`,
        ],
        [
            ...rows.map((row) => [button(label(row.name, 43) || "#" + row.monitorID, `monitor:${row.monitorID}`)]),
            [home()],
        ]
    );
}

/**
 * @param {object} result Recent audited changes by this actor
 * @returns {object} Actions recorded by the bot
 */
function journal(result) {
    const { rows, timezone } = result;
    return reply(
        [
            "Последние действия из Telegram",
            "",
            ...rows.map((row) => {
                const [first, second] = String(row.target ?? "").split(":");
                const target = second ? `окно #${first}, монитор #${second}` : `монитор #${first}`;
                return `${when(Number(row.created_at), timezone)} · ${journalTitles[row.action]} · ${target}`;
            }),
            rows.length ? null : "Действий пока нет.",
            "",
            `Время · ${timezone}`,
        ],
        [[home()]]
    );
}

/**
 * @param {object} monitor Selected monitor
 * @returns {object} Fixed maintenance durations
 */
function durationMenu(monitor) {
    const { id, name } = monitor;
    const choices = durations.map((minutes) => button(`${minutes} мин`, `prepare:maintenance:${id}:${minutes}`));
    return reply(
        [`Техработы · ${label(name)}`, "На какой срок включить режим техработ?"],
        [choices.slice(0, 2), choices.slice(2), [monitorButton(id), home()]]
    );
}

/**
 * @param {object} request Prepared change
 * @param {string} key One-time approval key
 * @returns {object} Explicit confirmation with the named target
 */
function confirmation(request, key) {
    const { action, name, monitorID, argument, preview } = request;
    const hint = {
        pause: "Плановые проверки этого монитора будут приостановлены.",
        resume: "Монитор вернётся к сохранённому расписанию.",
        maintenance: `На ${argument} мин монитор перейдёт в режим техработ. Обычные проверки возобновятся по окончании окна.`,
        end: `Окно техработ #${argument} завершится. Дальше действует расписание монитора.`,
        aiCancel: `Запрос #${argument} будет остановлен. Если он уже отправлен провайдеру, он мог использовать лимит.`,
    };
    return reply(
        [
            actionTitles[action],
            `${label(name) || "Монитор"} · #${monitorID}`,
            "",
            ...(action === "aiDiagnosis"
                ? [
                      ...aiEvidence(preview.evidence),
                      "",
                      "Подтвердите отправку этих наблюдений ИИ проекта. Запрос учитывается в суточном лимите.",
                  ]
                : [hint[action]]),
            "Подтверждение действует 2 минуты.",
        ],
        [
            [
                button(action === "aiDiagnosis" ? "Отправить ИИ" : "Подтвердить", `yes:${key}`),
                button("Отмена", `no:${key}`),
            ],
        ]
    );
}

/**
 * @param {object} observation Typed facts from the existing AI preview
 * @returns {string} Exact saved measurements with Russian labels
 */
function aiObservation(observation) {
    const { time, status, ping, httpStatus, interval, work } = observation;
    return [
        time?.replace("T", " ").replace("Z", "") || "Время неизвестно",
        states[checks[status]] || `Статус · ${status ?? "неизвестен"}`,
        Number.isFinite(ping) ? `${ping} мс` : "Без замера отклика",
        httpStatus ? `HTTP ${httpStatus}` : null,
        Number.isFinite(interval) ? `интервал ${interval} с` : null,
        work ? `${strings["siteWorkKind_" + work.kind]} · ${strings["siteWorkPhase_" + work.phase]}` : null,
    ]
        .filter(Boolean)
        .join(" · ");
}

/**
 * @param {object} evidence The safe facts approved for sharing by the project
 * @returns {string[]} Readable preview of the facts sent to the model
 */
function aiEvidence(evidence) {
    const { state, reason, type, name, host, responseLimitMs, failure, latest, observations } = evidence;
    return [
        "Данные для отправки",
        `Проверка #${evidence.monitorID} · ${type} · ${states[state]}`,
        reason ? strings[reason] : null,
        failure?.httpStatus && failure.httpStatus !== latest?.httpStatus
            ? `Ответ сайта · HTTP ${failure.httpStatus}`
            : null,
        name === undefined ? null : `Название · ${label(name, 121) || "—"}`,
        host === undefined ? null : `Узел · ${host || "—"}`,
        Number.isFinite(responseLimitMs) ? `Порог отклика · ${responseLimitMs} мс` : null,
        "",
        latest ? "Последняя проверка (UTC)" : "Последней проверки нет.",
        latest ? aiObservation(latest) : null,
        ...(observations?.length ? ["", "Сохранённые наблюдения (UTC)", ...observations.map(aiObservation)] : []),
        "",
        "По этим наблюдениям нельзя установить точное время простоя.",
    ];
}

/**
 * @param {string} status Persisted diagnosis state
 * @returns {string} Russian status for the queue and the result
 */
function aiJobStatus(status) {
    return strings["projectAIJob_" + status] || "Состояние неизвестно";
}

/**
 * @param {object} data Scoped connection status and recent diagnoses
 * @returns {object} AI project menu or a single monitor's AI menu
 */
function aiOverview(data) {
    const { monitor, rows, automatic, state, canRun, url } = data;
    const navigation = monitor ? `ai-check:${monitor.id}` : "ai";
    const buttons = [];
    if (canRun && monitor) {
        buttons.push([button("Посмотреть данные и запустить", `ai-prepare:${monitor.id}`)]);
    }
    for (const { id, name, status } of rows) {
        buttons.push([
            button(`#${id} · ${aiJobStatus(status)}${monitor ? "" : " · " + label(name, 32)}`, `ai-job:${id}`),
        ]);
    }
    if (url) {
        buttons.push([{ text: "Открыть ИИ в панели", url }]);
    }
    buttons.push(
        monitor ? [monitorButton(monitor.id), button("← Личный ИИ", "ai")] : [button("Выбрать монитор", "list:all:0")]
    );
    buttons.push([button("Обновить", navigation), home()]);
    return reply(
        [
            monitor ? `Диагностика ИИ · ${label(monitor.name)} · #${monitor.id}` : "Личный ИИ",
            `Подключение · ${aiStates[state] || "Состояние неизвестно"}`,
            automatic ? `Автоматическая диагностика · ${automaticStates[automatic]}` : null,
            "",
            rows.length ? "Последние запросы диагностики" : "Запросов диагностики пока нет.",
        ],
        buttons
    );
}

/**
 * @param {object} job A saved diagnosis, with a result only if still authorized
 * @returns {object} Status, bounded response, and permitted controls
 */
function aiJob(job) {
    const { id, name, monitorID, status, trigger, createdAt, errorCode, result, timezone, url, canCancel } = job;
    const lines = [
        `Диагностика #${id} · ${label(name)}`,
        aiJobStatus(status),
        `${trigger === "automatic" ? "По событию" : "Вручную"} · ${when(createdAt, timezone)} (${timezone})`,
    ];
    if (errorCode && strings["projectAIError_" + errorCode]) {
        lines.push(strings["projectAIError_" + errorCode]);
    }
    if (result) {
        const groups = [
            [strings.projectAIFacts, result.facts],
            [
                strings.projectAIHypotheses,
                result.hypotheses.map(
                    ({ explanation, confidence }) => `${strings["projectAIConfidence_" + confidence]} · ${explanation}`
                ),
            ],
            [strings.projectAINextSteps, result.nextSteps],
            [strings.projectAILimitations, result.limitations],
        ];
        let shortened = false;
        for (const [title, items] of groups) {
            if (items.length) {
                lines.push("", title);
            }
            shortened ||= items.length > 3 || items.some((item) => Array.from(item).length > 140);
            lines.push(...items.slice(0, 3).map((item) => "• " + label(item, 140)));
        }
        if (shortened) {
            lines.push("", "Показан краткий ответ. Полный ответ можно открыть в панели.");
        }
    } else if (status === "completed") {
        lines.push("", "Посмотреть сохранённый ответ можно в разделе «Личный ИИ» панели.");
    }
    const rows = [[button("Обновить", `ai-job:${id}`)]];
    if (canCancel) {
        rows[0].push(button("Отменить запрос", `ai-stop:${id}`));
    }
    if (url) {
        rows.push([{ text: "Открыть ИИ в панели", url }]);
    }
    rows.push([button("← Диагностика", `ai-check:${monitorID}`), home()]);
    return reply(lines, rows);
}

/**
 * @param {number} id Diagnosis identifier
 * @param {boolean} cancelled Whether a queued or running request was cancelled
 * @returns {object} Accepted action with a direct link to the job state
 */
function aiChanged(id, cancelled) {
    return reply(
        [cancelled ? `Запрос ИИ #${id} отменён.` : `Запрос ИИ #${id} поставлен в очередь.`],
        [[button("Статус запроса", `ai-job:${id}`), button("← Личный ИИ", "ai")], [home()]]
    );
}

/**
 * @param {object} result Applied and audited change
 * @returns {object} Result of a confirmed action
 */
function changed(result) {
    const title = {
        pause: "Монитор на паузе.",
        resume: "Проверки возобновлены.",
        maintenance: `Техработы включены до ${when(result.end, result.timezone)} (${result.timezone}).`,
        end: "Окно техработ завершено.",
    };
    return reply(
        [result.syncFailed ? "Изменение сохранено. Текущее состояние нужно проверить в панели." : title[result.action]],
        [[monitorButton(result.monitorID), home()]]
    );
}

module.exports = {
    label,
    button,
    home,
    reply,
    summary,
    monitors,
    detail,
    history,
    report,
    certificates,
    deliveries,
    windows,
    journal,
    durationMenu,
    confirmation,
    changed,
    aiOverview,
    aiJob,
    aiChanged,
};
