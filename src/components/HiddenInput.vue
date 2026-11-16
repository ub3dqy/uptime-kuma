<template>
    <div class="input-group mb-3">
        <input
            v-bind="$attrs"
            ref="input"
            v-model="model"
            :type="visibility"
            class="form-control"
            :placeholder="placeholder"
            :maxlength="maxlength"
            :autocomplete="autocomplete"
            :required="required"
            :readonly="readonly"
        />

        <button
            type="button"
            class="btn btn-outline-primary"
            :aria-label="$t(visibility === 'password' ? 'workspaceRevealValue' : 'workspaceConcealValue')"
            @click="visibility = visibility === 'password' ? 'text' : 'password'"
        >
            <font-awesome-icon :icon="visibility === 'password' ? 'eye' : 'eye-slash'" aria-hidden="true" />
        </button>
    </div>
</template>

<script>
export default {
    inheritAttrs: false,
    props: {
        /** The value of the input */
        modelValue: {
            type: String,
            default: "",
        },
        /** A placeholder to use */
        placeholder: {
            type: String,
            default: "",
        },
        /** Maximum length of the input */
        maxlength: {
            type: Number,
            default: 255,
        },
        /** Should the field auto complete */
        autocomplete: {
            type: String,
            default: "new-password",
        },
        /** Is the input required? */
        required: {
            type: Boolean,
        },
        /** Should the input be read only? */
        readonly: {
            type: String,
            default: undefined,
        },
    },
    emits: ["update:modelValue"],
    data() {
        return {
            visibility: "password",
        };
    },
    computed: {
        model: {
            get() {
                return this.modelValue;
            },
            set(value) {
                this.$emit("update:modelValue", value);
            },
        },
    },
};
</script>
