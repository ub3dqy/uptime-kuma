<template>
    <div>
        <div class="my-4">
            <label for="language" class="form-label">
                {{ $t("Language") }}
            </label>
            <select id="language" v-model="$root.language" class="form-select">
                <option v-for="(lang, i) in $i18n.availableLocales" :key="`Lang${i}`" :value="lang">
                    {{ $i18n.messages[lang].languageName }}
                </option>
            </select>
        </div>
        <fieldset class="my-4">
            <legend class="form-label fs-6">{{ $t("Theme") }}</legend>
            <div>
                <div class="appearance-options">
                    <input
                        id="btncheck1"
                        v-model="$root.userTheme"
                        type="radio"
                        class="btn-check"
                        name="theme"
                        autocomplete="off"
                        value="light"
                    />
                    <label class="btn btn-outline-primary" for="btncheck1">
                        {{ $t("Light") }}
                    </label>

                    <input
                        id="btncheck2"
                        v-model="$root.userTheme"
                        type="radio"
                        class="btn-check"
                        name="theme"
                        autocomplete="off"
                        value="dark"
                    />
                    <label class="btn btn-outline-primary" for="btncheck2">
                        {{ $t("Dark") }}
                    </label>

                    <input
                        id="btncheck3"
                        v-model="$root.userTheme"
                        type="radio"
                        class="btn-check"
                        name="theme"
                        autocomplete="off"
                        value="auto"
                    />
                    <label class="btn btn-outline-primary" for="btncheck3">
                        {{ $t("Auto") }}
                    </label>
                </div>
            </div>
        </fieldset>
        <fieldset class="my-4">
            <legend class="form-label fs-6">{{ $t("Theme - Heartbeat Bar") }}</legend>
            <div>
                <div class="appearance-options">
                    <input
                        id="btncheck4"
                        v-model="$root.userHeartbeatBar"
                        type="radio"
                        class="btn-check"
                        name="heartbeatBarTheme"
                        autocomplete="off"
                        value="normal"
                    />
                    <label class="btn btn-outline-primary" for="btncheck4">
                        {{ $t("Normal") }}
                    </label>

                    <input
                        id="btncheck5"
                        v-model="$root.userHeartbeatBar"
                        type="radio"
                        class="btn-check"
                        name="heartbeatBarTheme"
                        autocomplete="off"
                        value="bottom"
                    />
                    <label class="btn btn-outline-primary" for="btncheck5">
                        {{ $t("Bottom") }}
                    </label>

                    <input
                        id="btncheck6"
                        v-model="$root.userHeartbeatBar"
                        type="radio"
                        class="btn-check"
                        name="heartbeatBarTheme"
                        autocomplete="off"
                        value="none"
                    />
                    <label class="btn btn-outline-primary" for="btncheck6">
                        {{ $t("None") }}
                    </label>
                </div>
            </div>
        </fieldset>

        <!-- Timeline -->
        <fieldset class="my-4">
            <legend class="form-label fs-6">{{ $t("styleElapsedTime") }}</legend>
            <div>
                <div class="appearance-options">
                    <input
                        id="styleElapsedTimeShowNoLine"
                        v-model="$root.styleElapsedTime"
                        type="radio"
                        class="btn-check"
                        name="styleElapsedTime"
                        autocomplete="off"
                        value="no-line"
                    />
                    <label class="btn btn-outline-primary" for="styleElapsedTimeShowNoLine">
                        {{ $t("styleElapsedTimeShowNoLine") }}
                    </label>

                    <input
                        id="styleElapsedTimeShowWithLine"
                        v-model="$root.styleElapsedTime"
                        type="radio"
                        class="btn-check"
                        name="styleElapsedTime"
                        autocomplete="off"
                        value="with-line"
                    />
                    <label class="btn btn-outline-primary" for="styleElapsedTimeShowWithLine">
                        {{ $t("styleElapsedTimeShowWithLine") }}
                    </label>

                    <input
                        id="styleElapsedTimeNone"
                        v-model="$root.styleElapsedTime"
                        type="radio"
                        class="btn-check"
                        name="styleElapsedTime"
                        autocomplete="off"
                        value="none"
                    />
                    <label class="btn btn-outline-primary" for="styleElapsedTimeNone">
                        {{ $t("None") }}
                    </label>
                </div>
            </div>
        </fieldset>
    </div>
</template>

<script>
export default {};
</script>

<style lang="scss" scoped>
.appearance-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(105px, 100%), 1fr));
    gap: 8px;
}

.appearance-options label {
    display: grid;
    align-content: center;
    min-height: 44px;
    border-color: var(--ws-control-border);
    color: var(--ws-ink);
    overflow-wrap: anywhere;
}

.appearance-options :checked + label,
.appearance-options label:hover {
    border-color: var(--ws-action);
    color: var(--ws-action);
    background: var(--ws-action-soft);
}

.appearance-options :focus-visible + label {
    outline: 3px solid #347bc4;
    outline-offset: 2px;
}
</style>
