<template>
    <span v-if="isNum" class="pm-observed-number">
        <Transition name="pm-number" mode="out-in">
            <span :key="value">{{ formatted }} {{ unit }}</span>
        </Transition>
    </span>
    <span v-else>{{ value }}</span>
</template>

<script>
export default {
    props: {
        /** Value to count */
        value: {
            type: [String, Number],
            default: 0,
        },
        /** Unit of the value */
        unit: {
            type: String,
            default: "ms",
        },
    },

    computed: {
        isNum() {
            return typeof this.value === "number";
        },
        formatted() {
            return new Intl.NumberFormat(this.$i18n.locale, { maximumFractionDigits: 2 }).format(this.value);
        },
    },
};
</script>
