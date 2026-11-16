<template>
    <div class="pm-observation-trace" :class="{ 'is-detailed': detailed }" data-testid="observation-trace">
        <span v-if="!trace.entries.length" class="pm-trace-waiting">{{ $t("premiumTraceNoHistory") }}</span>
        <div
            v-else
            class="pm-trace-control"
            role="slider"
            tabindex="0"
            :aria-label="$t('premiumServiceObservations', { name })"
            :aria-describedby="guideId"
            :aria-valuemin="1"
            :aria-valuemax="trace.entries.length"
            :aria-valuenow="activeIndex + 1"
            :aria-valuetext="reading"
            @focus="focused = $event.currentTarget.matches(':focus-visible')"
            @blur="closeReading"
            @pointermove="hoverReading"
            @pointerleave="hovering = false"
            @click="toggleReading"
            @keydown="onKey"
        >
            <span :id="guideId" class="visually-hidden">{{ $t("premiumTraceGuide") }}</span>
            <div
                class="pm-trace-visual"
                :style="{ '--trace-mark-width': 68 / trace.samples.length + '%' }"
                aria-hidden="true"
            >
                <div class="pm-trace-scale">
                    <template v-if="trace.measurements">
                        <span>{{ milliseconds(trace.ceiling) }}</span>
                        <span>0</span>
                    </template>
                </div>
                <div class="pm-trace-chart">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                        <defs v-if="trace.paths.length">
                            <linearGradient :id="fillId" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
                                <stop offset="0" stop-opacity="0.17" />
                                <stop offset="1" stop-opacity="0.025" />
                            </linearGradient>
                        </defs>
                        <path class="pm-trace-grid" d="M2 8H98 M2 50H98 M2 92H98" />
                        <path v-for="path in trace.paths" :key="path.key" :fill="`url(#${fillId})`" :d="path.area" />
                        <path v-for="path in trace.paths" :key="path.key" class="pm-trace-line" :d="path.line" />
                        <path
                            v-if="arrival && trace.tail"
                            :key="arrival"
                            class="pm-trace-arrival-line"
                            pathLength="1"
                            :d="trace.tail"
                        />
                        <path v-if="showReading" class="pm-trace-cursor" :d="`M${activeEntry.x} 4V98`" />
                    </svg>
                    <span v-if="!trace.measurements" class="pm-trace-no-response">
                        {{ $t("premiumTraceNoResponse") }}
                    </span>
                    <template v-for="sample in trace.samples" :key="sample.key">
                        <i
                            v-if="sample.y !== null"
                            class="pm-trace-point"
                            :class="[
                                `pm-trace-${sample.state}`,
                                {
                                    'is-latest': sample.key === latest.key,
                                    'is-selected': showReading && sample.key === activeEntry.key,
                                },
                            ]"
                            :style="{ left: sample.x + '%', top: sample.y + '%' }"
                        />
                    </template>
                    <i
                        v-if="arrival && latest.y !== null"
                        :key="arrival"
                        class="pm-trace-arrival-ring"
                        :class="`pm-trace-${latest.state}`"
                        :style="{ left: latest.x + '%', top: latest.y + '%' }"
                    />
                </div>
                <div ref="track" class="pm-trace-track">
                    <i
                        v-for="gap in trace.gaps"
                        :key="gap.key"
                        class="pm-trace-gap"
                        :class="{ 'is-selected': showReading && activeEntry.key === gap.key }"
                        :style="{ left: gap.left + '%', width: gap.width + '%' }"
                    />
                    <i
                        v-for="sample in trace.samples"
                        :key="sample.key"
                        class="pm-trace-mark"
                        :class="[
                            `pm-trace-${sample.state}`,
                            {
                                'is-latest': sample.key === latest.key,
                                'is-selected': showReading && activeEntry.key === sample.key,
                            },
                        ]"
                        :data-state="sample.state"
                        :style="{ left: sample.x + '%' }"
                    />
                    <i
                        v-if="arrival"
                        :key="arrival"
                        class="pm-trace-arrival-mark"
                        :class="`pm-trace-${latest.state}`"
                        :style="{ left: latest.x + '%' }"
                    />
                </div>
                <div class="pm-trace-time">
                    <time v-if="trace.start !== trace.end" :datetime="isoTime(trace.start)">
                        {{ axisTime(trace.start) }}
                    </time>
                    <time :datetime="isoTime(trace.end)">{{ axisTime(trace.end) }}</time>
                </div>
                <div v-if="showReading" class="pm-trace-reading" data-testid="observation-reading" dir="auto">
                    <span>{{ readingTime }}</span>
                    <strong>{{ readingStatus }}</strong>
                    <span v-if="readingResponse">{{ readingResponse }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { useId } from "vue";
import { observationTrace } from "../observation-chart.ts";
import { observationTime } from "../overview-state.ts";

const statusLabels = {
    up: "workspaceStateWorking",
    down: "workspaceStateDown",
    pending: "workspaceStatePending",
    maintenance: "workspaceStateMaintenance",
    unknown: "workspaceStateUnknown",
};

export default {
    props: {
        monitorId: { type: Number, required: true },
        name: { type: String, required: true },
        observations: { type: Array, required: true },
        now: { type: Number, required: true },
        detailed: { type: Boolean, default: false },
    },
    setup() {
        const id = useId();
        return { guideId: id + "-observation-guide", fillId: id + "-observation-fill" };
    },
    data() {
        return { selectedKey: "", hovering: false, focused: false, pinned: false, liveTime: 0, animateArrival: false };
    },
    computed: {
        trace() {
            return observationTrace(this.observations, Math.max(this.now, this.liveTime), this.detailed ? 120 : 24);
        },
        latest() {
            return this.trace.samples.at(-1);
        },
        arrival() {
            return this.$root.socket.connected && this.animateArrival && this.latest?.time === this.liveTime
                ? this.latest.key
                : "";
        },
        activeIndex() {
            const index = this.trace.entries.findIndex((entry) => entry.key === this.selectedKey);
            return index < 0 ? Math.max(0, this.trace.entries.length - 1) : index;
        },
        activeEntry() {
            return this.trace.entries[this.activeIndex];
        },
        showReading() {
            return Boolean(this.activeEntry && (this.hovering || this.focused || this.pinned));
        },
        formatters() {
            const locale = this.$i18n.locale;
            const zone = this.$root.timezone;
            let timeZone;
            try {
                timeZone = new Intl.DateTimeFormat(locale, { timeZone: zone }).resolvedOptions().timeZone;
            } catch {
                // A setting from another browser may name a zone unavailable here.
                timeZone = undefined;
            }
            const short = { hour: "2-digit", minute: "2-digit", timeZone };
            return {
                date: new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone }),
                minutes: new Intl.DateTimeFormat(locale, short),
                seconds: new Intl.DateTimeFormat(locale, { ...short, second: "2-digit" }),
                dated: new Intl.DateTimeFormat(locale, { ...short, day: "numeric", month: "short" }),
                full: new Intl.DateTimeFormat(locale, {
                    ...short,
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    second: "2-digit",
                }),
                number: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
            };
        },
        readingTime() {
            const entry = this.activeEntry;
            if (!entry) return "";
            return entry.kind === "gap"
                ? this.formatters.full.formatRange(entry.time, entry.endTime)
                : this.formatters.full.format(entry.time);
        },
        readingStatus() {
            const entry = this.activeEntry;
            if (!entry) return "";
            if (entry.kind === "gap") return this.$t("premiumTraceGap");
            const reason = entry.issue && entry.issue !== "workspaceIssueUnreachable" ? entry.issue + "Short" : null;
            return this.$t(reason && this.$te(reason, "en") ? reason : statusLabels[entry.state]);
        },
        readingResponse() {
            const entry = this.activeEntry;
            if (entry?.kind !== "sample") return "";
            return entry.ping === null ? this.$t("premiumTraceNoResponse") : this.milliseconds(entry.ping);
        },
        reading() {
            return [this.readingTime, this.readingStatus, this.readingResponse].filter(Boolean).join(" · ");
        },
    },
    watch: {
        trace(next) {
            if (this.selectedKey && !next.entries.some((entry) => entry.key === this.selectedKey)) {
                this.closeReading();
            }
        },
        "$root.socket.connected"(connected) {
            if (!connected) {
                this.animateArrival = false;
                this.closeReading();
            }
        },
    },
    mounted() {
        this.$root.emitter.on("newSavedObservation", this.onObservation);
    },
    beforeUnmount() {
        this.$root.emitter.off("newSavedObservation", this.onObservation);
    },
    methods: {
        /**
         * @param {number} value Saved timestamp
         * @returns {string} UTC timestamp for the browser
         */
        isoTime(value) {
            return new Date(value).toISOString();
        },
        /**
         * @param {number} value Saved timestamp
         * @returns {string} Label in the selected time zone
         */
        axisTime(value) {
            const { start, end } = this.trace;
            const day = this.formatters.date.format(start);
            if (day !== this.formatters.date.format(end) || day !== this.formatters.date.format(this.now)) {
                return this.formatters.dated.format(value);
            }
            return (end - start < 120000 ? this.formatters.seconds : this.formatters.minutes).format(value);
        },
        /**
         * @param {number} value Measured milliseconds
         * @returns {string} Localized reading
         */
        milliseconds(value) {
            return this.$t("workspaceMilliseconds", { value: this.formatters.number.format(value) });
        },
        /**
         * @param {{monitorID: number, time: string}} event Saved live result
         * @returns {void}
         */
        onObservation(event) {
            if (event.monitorID !== this.monitorId) return;
            const savedAt = observationTime(event.time);
            if (savedAt === null || savedAt <= this.liveTime) return;
            // The server broadcasts after saving. Its timestamp can be ahead of the browser's clock.
            this.liveTime = savedAt;
            this.animateArrival = true;
        },
        /** @returns {void} Remove the active overlay */
        closeReading() {
            this.hovering = false;
            this.focused = false;
            this.pinned = false;
            this.selectedKey = "";
        },
        /**
         * In a wide gap, inspect the gap itself; at either edge prefer the saved point.
         * @param {number} clientX Pointer position on the screen
         * @returns {string} Stable key of the inspected entry
         */
        pointerKey(clientX) {
            const rect = this.$refs.track.getBoundingClientRect();
            const x = ((clientX - rect.left) / rect.width) * 100;
            const nearest = this.trace.samples.reduce((best, point) =>
                Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best
            );
            if ((Math.abs(nearest.x - x) * rect.width) / 100 <= 6) return nearest.key;
            return this.trace.gaps.find((gap) => x > gap.left && x < gap.left + gap.width)?.key ?? nearest.key;
        },
        /**
         * @param {PointerEvent} event Chart pointer event
         * @returns {void}
         */
        hoverReading(event) {
            if (event.pointerType !== "mouse" || this.pinned) return;
            this.selectedKey = this.pointerKey(event.clientX);
            this.hovering = true;
        },
        /**
         * @param {MouseEvent} event Chart tap or click
         * @returns {void}
         */
        toggleReading(event) {
            const key = this.pointerKey(event.clientX);
            this.pinned = !this.pinned || key !== this.selectedKey;
            this.selectedKey = key;
        },
        /**
         * @param {KeyboardEvent} event Chart navigation
         * @returns {void}
         */
        onKey(event) {
            if (event.key === "Escape") {
                this.closeReading();
                return;
            }
            const end = this.trace.entries.length - 1;
            const indexes = {
                ArrowLeft: Math.max(0, this.activeIndex - 1),
                ArrowDown: Math.max(0, this.activeIndex - 1),
                ArrowRight: Math.min(end, this.activeIndex + 1),
                ArrowUp: Math.min(end, this.activeIndex + 1),
                Home: 0,
                End: end,
            };
            if (Object.hasOwn(indexes, event.key)) {
                event.preventDefault();
                this.selectedKey = this.trace.entries[indexes[event.key]].key;
                this.focused = true;
            }
        },
    },
};
</script>

<style scoped lang="scss">
.pm-observation-trace {
    min-width: 0;
    pointer-events: none;
}

.pm-trace-control {
    position: relative;
    min-height: 67px;
    border-radius: 6px;
    cursor: crosshair;
    pointer-events: auto;
}

.pm-trace-control:focus-visible {
    outline: 2px solid var(--ws-action);
    outline-offset: 4px;
}

.pm-trace-visual {
    position: relative;
    display: grid;
    grid-template: 44px 10px auto / 52px minmax(0, 1fr);
    gap: 3px 8px;
    direction: ltr;
    font-variant-numeric: tabular-nums;
}

.pm-trace-scale {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: space-between;
    color: var(--ws-muted);
    font-size: 12px;
    line-height: 1.1;
    white-space: nowrap;
}

.is-detailed .pm-trace-visual {
    grid-template-rows: clamp(104px, 14vw, 160px) 13px auto;
    row-gap: 5px;
}

.is-detailed .pm-trace-scale {
    padding-block: 7px;
}

.pm-trace-chart {
    position: relative;
    min-width: 0;
}

.pm-trace-chart svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
}

.pm-trace-grid,
.pm-trace-line,
.pm-trace-cursor,
.pm-trace-arrival-line {
    fill: none;
    vector-effect: non-scaling-stroke;
}

.pm-trace-grid {
    stroke: var(--ws-border);
    stroke-width: 1;
    stroke-dasharray: 2 3;
}

.pm-trace-line,
.pm-trace-arrival-line {
    stroke: var(--trace-good);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.pm-trace-chart stop {
    stop-color: var(--trace-good);
}

.pm-trace-cursor {
    stroke: var(--ws-muted);
    stroke-width: 1;
    stroke-dasharray: 2 2;
}

.pm-trace-up {
    --trace-tone: var(--trace-good);
}

.pm-trace-down {
    --trace-tone: var(--trace-bad);
}

.pm-trace-pending {
    --trace-tone: var(--trace-pending);
}

.pm-trace-maintenance {
    --trace-tone: var(--trace-maintenance);
}

.pm-trace-point {
    position: absolute;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--trace-tone, var(--ws-muted));
    transform: translate(-50%, -50%);
    pointer-events: none;
}

.pm-trace-point.is-latest,
.pm-trace-point.is-selected {
    z-index: 1;
    width: 7px;
    height: 7px;
    box-shadow:
        0 0 0 2px var(--ws-surface),
        0 0 0 3px var(--trace-tone, var(--ws-muted));
}

.pm-trace-track {
    position: relative;
    grid-column: 2;
}

.pm-trace-gap,
.pm-trace-mark,
.pm-trace-arrival-mark {
    position: absolute;
    height: 100%;
    border-radius: 2px;
}

.pm-trace-gap {
    background: repeating-linear-gradient(
        135deg,
        transparent 0 2px,
        color-mix(in srgb, var(--ws-muted) 34%, transparent) 2px 3px,
        transparent 3px 5px
    );
}

.pm-trace-mark,
.pm-trace-arrival-mark {
    width: clamp(1px, var(--trace-mark-width, 2.9%), 13px);
    border: 1px solid var(--ws-surface);
    background: var(--trace-tone, var(--ws-muted));
    transform: translateX(-50%);
}

.pm-trace-mark.pm-trace-up:not(.is-latest, .is-selected) {
    background: color-mix(in srgb, var(--trace-good) 73%, var(--ws-surface));
}

.pm-trace-mark:is(.pm-trace-down, .pm-trace-pending, .pm-trace-maintenance) {
    z-index: 1;
    min-width: 4px;
}

.pm-trace-mark.pm-trace-down::after,
.pm-trace-mark.pm-trace-maintenance::after,
.pm-trace-mark.pm-trace-pending::after {
    position: absolute;
    inset: 3px 1px;
    border-block-start: 1px solid var(--ws-surface);
    content: "";
}

.pm-trace-mark.pm-trace-pending::after {
    inset-inline: calc(50% - 0.5px);
}

.pm-trace-mark.pm-trace-maintenance::after {
    border: 0;
    border-inline: 1px solid var(--ws-surface);
}

.pm-trace-mark.is-selected,
.pm-trace-gap.is-selected {
    z-index: 2;
    outline: 1px solid var(--ws-ink);
    outline-offset: 1px;
}

.pm-trace-time {
    display: flex;
    grid-column: 2;
    justify-content: space-between;
    gap: 4px;
    padding-inline: 2%;
    color: var(--ws-muted);
    font-size: 12px;
    line-height: 1.2;
    flex-wrap: wrap;
}

.pm-trace-time time:last-child {
    margin-inline-start: auto;
    text-align: end;
}

.pm-trace-waiting,
.pm-trace-no-response {
    color: var(--ws-muted);
    font-size: 12px;
}

.pm-trace-waiting {
    display: flex;
    align-items: center;
    min-height: 67px;
    padding-inline-start: 10px;
}

.pm-trace-no-response {
    position: absolute;
    inset: 50% auto auto 50%;
    max-width: 95%;
    padding-inline: 7px;
    border-radius: 3px;
    background: var(--ws-surface);
    text-align: center;
    transform: translate(-50%, -50%);
    pointer-events: none;
}

.pm-trace-reading {
    position: absolute;
    z-index: 3;
    inset: auto 0 calc(100% - 3px) auto;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 9px;
    align-items: baseline;
    max-width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--ws-border);
    border-radius: 6px;
    background: var(--ws-surface);
    box-shadow: 0 3px 13px rgba(15, 34, 53, 0.13);
    color: var(--ws-ink);
    font-size: 12px;
    line-height: 1.3;
    pointer-events: none;
    animation: pm-trace-reading-in 140ms ease-out both;
}

.pm-trace-reading > span {
    color: var(--ws-muted);
}

.pm-trace-arrival-line {
    stroke: color-mix(in srgb, var(--trace-good) 72%, var(--ws-surface));
    stroke-width: 2.5;
    stroke-dasharray: 1 1;
    animation: pm-trace-tail-in 660ms ease-out both;
}

.pm-trace-arrival-ring {
    position: absolute;
    z-index: 2;
    width: 10px;
    height: 10px;
    border: 1px solid var(--trace-tone, var(--ws-muted));
    border-radius: 50%;
    pointer-events: none;
    animation: pm-trace-ring-in 840ms ease-out both;
}

.pm-trace-arrival-mark {
    z-index: 2;
    pointer-events: none;
    animation: pm-trace-mark-in 680ms ease-out both;
}

@keyframes pm-trace-tail-in {
    0% {
        stroke-dashoffset: 1;
        opacity: 0.65;
    }

    60% {
        stroke-dashoffset: 0;
        opacity: 0.95;
    }

    100% {
        stroke-dashoffset: 0;
        opacity: 0;
    }
}

@keyframes pm-trace-ring-in {
    from {
        opacity: 0.7;
        transform: translate(-50%, -50%) scale(0.65);
    }

    to {
        opacity: 0;
        transform: translate(-50%, -50%) scale(2.7);
    }
}

@keyframes pm-trace-mark-in {
    0% {
        opacity: 0;
        transform: translateX(-50%) scaleY(0.55);
    }

    35% {
        opacity: 1;
        transform: translateX(-50%) scaleY(1.28);
    }

    100% {
        opacity: 0;
        transform: translateX(-50%) scaleY(1);
    }
}

@keyframes pm-trace-reading-in {
    from {
        opacity: 0;
        transform: translateY(3px);
    }

    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@media (prefers-reduced-motion: reduce) {
    .pm-trace-reading {
        animation: none;
    }

    .pm-trace-arrival-line,
    .pm-trace-arrival-ring,
    .pm-trace-arrival-mark {
        display: none;
    }
}
</style>
