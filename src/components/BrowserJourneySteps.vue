<template>
    <fieldset class="ws-alert-wizard">
        <legend class="h5">{{ $t("browserJourneyTitle") }}</legend>
        <p class="ws-channel-note">{{ $t("browserJourneyHelp") }}</p>
        <ol v-if="modelValue.length" class="ps-3 mb-3">
            <li v-for="(step, index) in modelValue" :key="index" class="mb-3">
                <div class="ws-wizard-fields">
                    <label>
                        {{ $t("browserJourneyAction") }}
                        <select
                            :value="step.action"
                            class="form-select"
                            @change="update(index, 'action', $event.target.value)"
                        >
                            <option value="click">{{ $t("browserJourneyClick") }}</option>
                            <option value="visible">{{ $t("browserJourneyVisible") }}</option>
                        </select>
                    </label>
                    <label>
                        {{ $t("browserJourneyText") }}
                        <input
                            :value="step.text"
                            class="form-control"
                            required
                            maxlength="120"
                            @input="update(index, 'text', $event.target.value)"
                        />
                    </label>
                </div>
                <button type="button" class="ws-button ws-button-quiet mt-2" @click="remove(index)">
                    {{ $t("browserJourneyRemove") }}
                </button>
            </li>
        </ol>
        <button
            v-if="modelValue.length < 8"
            type="button"
            class="ws-button ws-button-quiet"
            @click="$emit('update:modelValue', [...modelValue, { action: 'visible', text: '' }])"
        >
            {{ $t("browserJourneyAdd") }}
        </button>
    </fieldset>
</template>

<script>
export default {
    props: { modelValue: { type: Array, default: () => [] } },
    emits: ["update:modelValue"],
    methods: {
        /**
         * @param {number} index Edited step
         * @param {string} field Edited field
         * @param {string} value New value
         * @returns {void} Update the steps without modifying the prop
         */
        update(index, field, value) {
            const steps = [...this.modelValue];
            steps[index] = { ...steps[index], [field]: value };
            this.$emit("update:modelValue", steps);
        },
        /**
         * @param {number} index Removed step
         * @returns {void} Update the form
         */
        remove(index) {
            this.$emit(
                "update:modelValue",
                this.modelValue.filter((_step, position) => position !== index)
            );
        },
    },
};
</script>
