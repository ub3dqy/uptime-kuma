<template>
    <router-view />
    <Toaster
        position="bottom-right"
        :theme="$root.theme"
        :duration="5000"
        offset="80px"
        rich-colors
        close-button
        expand
    />
</template>

<script>
import { Toaster } from "vue-sonner";
import { setPageLocale } from "./util-frontend";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
export default {
    components: { Toaster },
    created() {
        setPageLocale();
    },
};
polyfillCountryFlagEmojis();
</script>
