<template>
    <span class="pm-observed-number">
        <Transition name="pm-number" mode="out-in">
            <span :key="String(value)">{{ value }}</span>
        </Transition>
    </span>
</template>

<script>
export default {
    props: { value: { type: Number, required: true } },
};
</script>
