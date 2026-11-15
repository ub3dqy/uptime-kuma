import { workflowRequest } from "../notification-workflow";
export default {
    props: { monitorId: { type: Number, default: null }, deliveryRequest: { type: Function, default: null } },
    data() {
        return {
            deliveryData: { channels: [], deliveries: [] },
            deliveryError: "",
            deliveryGeneration: 0,
            deliveryClock: null,
            deliveryLoading: false,
        };
    },
    watch: {
        monitorId() {
            this.deliveryGeneration++;
            this.deliveryData = { channels: [], deliveries: [] };
            this.deliveryLoading = false;
            this.refreshDelivery();
        },
        "$root.socket.connected"(connected) {
            if (connected) {
                this.refreshDelivery();
            }
        },
    },
    mounted() {
        this.refreshDelivery();
        this.deliveryClock = setInterval(() => this.refreshDelivery(), 5000);
    },
    beforeUnmount() {
        clearInterval(this.deliveryClock);
        this.deliveryGeneration++;
    },
    methods: {
        /** @returns {Promise<void>} Fresh owner-scoped delivery facts */
        async refreshDelivery() {
            if (!this.$root.loggedIn || !this.$root.socket.connected || this.deliveryLoading) {
                return;
            }
            const generation = this.deliveryGeneration;
            this.deliveryLoading = true;
            try {
                const request = {
                    monitorID: this.monitorId,
                };
                const result = this.deliveryRequest
                    ? await this.deliveryRequest(request)
                    : await workflowRequest(this.$root, "getNotificationDelivery", request);
                if (generation !== this.deliveryGeneration) {
                    return;
                }
                this.deliveryData = result;
                this.deliveryError = "";
            } catch {
                if (generation === this.deliveryGeneration) {
                    this.deliveryError = "stage2DeliveryUnavailable";
                }
            } finally {
                if (generation === this.deliveryGeneration) {
                    this.deliveryLoading = false;
                }
            }
        },
    },
};
