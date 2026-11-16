<template>
    <svg
        class="workspace-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        <path v-for="(path, index) in paths" :key="index" :d="path" />
    </svg>
</template>

<script>
const icons = {
    overview: ["M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"],
    monitors: ["M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"],
    alerts: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"],
    reports: ["M4 21V11h4v10M10 21V3h4v18M16 21V7h4v14"],
    settings: [
        "M10 3h4l1 3 3-1 2 3-2 3 2 3-2 3-3-1-1 3h-4l-1-3-3 1-2-3 2-3-2-3 2-3 3 1Z",
        "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    ],
    plus: ["M12 5v14M5 12h14"],
    close: ["m6 6 12 12M6 18 18 6"],
    search: ["M16 16 21 21M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0"],
    arrow: ["m9 5 7 7-7 7"],
    check: ["m5 12 4 4 10-10"],
    warning: ["m12 3 10 18H2ZM12 9v5M12 17v.1"],
    clock: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2"],
    pause: ["M8 5v14M16 5v14"],
    unknown: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5M12 17v.1"],
    mail: ["M3 5h18v14H3ZM3 6l9 7 9-7"],
    telegram: ["m22 3-4 18-7-5-4 3 1-6ZM8 13 18 7"],
    activity: ["M2 12h5l3-8 4 16 3-8h5"],
    sparkles: ["m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z", "m19 2 .7 2.3L22 5l-2.3.7L19 8l-.7-2.3L16 5l2.3-.7Z"],
    shield: ["M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z", "m8 12 3 3 5-6"],
    restore: ["M3 11a9 9 0 1 1 2 7M3 4v7h7", "M12 7v5l3 2"],
    folder: ["M3 5h6l2 3h10v12H3Z"],
};
export default {
    props: { name: { type: String, default: "activity" } },
    computed: {
        paths() {
            return Object.hasOwn(icons, this.name) ? icons[this.name] : icons.activity;
        },
    },
};
</script>
