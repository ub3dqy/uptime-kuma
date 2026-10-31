<template>
    <div ref="host" class="code-editor"></div>
</template>

<script>
import { markRaw } from "vue";
import { createEditor } from "prism-code-editor";
import { editorCommands, defaultKeymap, editHistory } from "prism-code-editor/commands";
import "prism-code-editor/layout.css";
import "prism-code-editor/themes/github-dark.css";
import "prism-code-editor/prism/languages/css";
import "prism-code-editor/prism/languages/javascript";

export default {
    props: {
        modelValue: { type: String, default: "" },
        language: { type: String, default: "text" },
        readonly: { type: Boolean, default: false },
        lineNumbers: { type: Boolean, default: true },
        label: { type: String, default: "Code" },
    },
    emits: ["update:modelValue"],
    watch: {
        modelValue(value) {
            if (this.editor && value !== this.editor.value) {
                this.editor.setOptions({ value });
            }
        },
        language(language) {
            this.editor?.setOptions({ language });
        },
        readonly(readOnly) {
            this.editor?.setOptions({ readOnly });
            if (this.editor) {
                this.editor.textarea.readOnly = readOnly;
            }
        },
        lineNumbers(lineNumbers) {
            this.editor?.setOptions({ lineNumbers });
        },
        label(value) {
            this.editor?.textarea.setAttribute("aria-label", value);
        },
    },
    mounted() {
        this.editor = markRaw(
            createEditor(
                this.$refs.host,
                {
                    language: this.language,
                    value: this.modelValue,
                    readOnly: this.readonly,
                    lineNumbers: this.lineNumbers,
                    onUpdate: (value) => {
                        if (value !== this.modelValue) {
                            this.$emit("update:modelValue", value);
                        }
                    },
                },
                editorCommands(defaultKeymap),
                editHistory()
            )
        );
        this.editor.textarea.setAttribute("aria-label", this.label);
        this.editor.textarea.readOnly = this.readonly;
    },
    beforeUnmount() {
        this.editor?.remove();
        this.editor = null;
    },
};
</script>

<style scoped>
.code-editor {
    display: grid;
    min-height: 5rem;
}

.code-editor :deep(.prism-code-editor) {
    min-height: 5rem;
    font-family: Consolas, Monaco, monospace;
    font-size: 14px;
    border-radius: 0.5rem;
}
</style>
