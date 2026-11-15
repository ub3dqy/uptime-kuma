<template>
    <div class="container-fluid" :class="{ 'workspace-full-page': fullPage }">
        <div class="row">
            <div v-if="!$root.isMobile && !fullPage" class="col-12 col-md-5 col-xl-4 ps-0">
                <div>
                    <router-link to="/add" class="btn btn-primary mb-3">
                        <font-awesome-icon icon="plus" />
                        {{ $t("Add New Monitor") }}
                    </router-link>
                </div>
                <MonitorList :scrollbar="true" />
            </div>

            <div ref="container" class="col-12 mb-3 gx-0" :class="{ 'col-md-7 col-xl-8': !fullPage }">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>
import MonitorList from "../components/MonitorList.vue";

export default {
    components: {
        MonitorList,
    },
    data() {
        return {
            height: 0,
        };
    },
    computed: {
        fullPage() {
            return (
                ["DashboardHome", "Events"].includes(this.$route.name) ||
                ["/clients", "/notifications", "/list"].includes(this.$route.path) ||
                this.$route.path.startsWith("/dashboard/") ||
                this.$route.path.startsWith("/projects") ||
                this.$route.path === "/account" ||
                this.$route.path.startsWith("/settings")
            );
        },
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
};
</script>

<style lang="scss" scoped>
.container-fluid {
    width: 98%;
}

.workspace-full-page {
    width: 100%;
}
</style>
