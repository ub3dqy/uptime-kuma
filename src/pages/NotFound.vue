<template>
    <main class="workspace-shell ws-access" :class="{ dark: $root.isDark }" data-testid="page-not-found">
        <section class="ws-access-panel" aria-labelledby="missing-title">
            <header class="ws-access-heading">
                <router-link to="/" class="workspace-brand">
                    <img src="/images/kuma-pulse.png" width="32" height="32" alt="" />
                    Uptime Kuma
                </router-link>
                <p class="ws-eyebrow">404</p>
                <h1 id="missing-title">{{ $t("Page Not Found") }}</h1>
            </header>
            <p>
                {{ $t("The resource is no longer available.") }}
                {{ $t("There might be a typing error in the address.") }}
            </p>
            <div class="ws-access-actions">
                <router-link to="/" class="ws-button ws-button-primary">{{ $t("Go back to home page.") }}</router-link>
                <button v-if="canGoBack" type="button" class="ws-button ws-button-quiet" @click="$router.back()">
                    {{ $t("stage2Back") }}
                </button>
            </div>
        </section>
    </main>
</template>

<script>
export default {
    data() {
        return { canGoBack: Boolean(history.state?.back) };
    },
};
</script>
