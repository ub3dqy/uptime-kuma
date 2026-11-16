<template>
    <div class="pm-lens" :class="{ 'is-connected': connected }" aria-hidden="true" data-testid="monitoring-lens">
        <div class="pm-lens-light" />
        <img
            class="pm-lens-body"
            src="/images/monitoring-lens-v3.png"
            width="1312"
            height="1199"
            alt=""
            draggable="false"
        />
        <svg class="pm-lens-signal" viewBox="0 0 600 320" fill="none" focusable="false">
            <defs>
                <filter :id="`${identity}-light`" x="-50%" y="-100%" width="200%" height="300%">
                    <feGaussianBlur stdDeviation="3" />
                </filter>
                <clipPath :id="`${identity}-face`">
                    <ellipse cx="300" cy="157" rx="88" ry="112" transform="rotate(7 300 157)" />
                </clipPath>
            </defs>
            <path class="pm-lens-trace" :d="signal" />
            <g :clip-path="`url(#${identity}-face)`">
                <path class="pm-lens-core-glow" :d="signal" :filter="`url(#${identity}-light)`" />
                <path class="pm-lens-core-trace" :d="signal" />
            </g>
            <path class="pm-lens-flow" :d="signal" pathLength="1000" />
            <g class="pm-lens-orbit">
                <ellipse cx="300" cy="157" rx="148" ry="138" />
                <circle cx="448" cy="157" r="4" />
            </g>
        </svg>
    </div>
</template>

<script>
import { useId } from "vue";
export default {
    props: { connected: { type: Boolean, default: false } },
    setup() {
        return { identity: "monitor-lens-" + useId().replace(/[^a-zA-Z0-9-]/g, "") };
    },
    data() {
        return {
            signal: "M0 158C34 158 38 132 66 143S107 177 139 158S179 155 213 158H258L269 153L278 165L291 119L307 192L322 151L334 158H376C389 158 391 137 400 146S409 164 417 158H442C450 158 452 120 460 126S474 192 482 185S489 141 498 150S512 158 526 158H600",
        };
    },
};
</script>
