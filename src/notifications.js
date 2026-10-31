import { toast as notify } from "vue-sonner";

/**
 * Preserve the stored timeout settings and the existing notification callers.
 * @returns {Function} Notification helper.
 */
export function useToast() {
    const send = (kind, message, options = {}) => {
        if (options.timeout === 0) {
            return;
        }
        const { timeout, ...rest } = options;
        const settings = { ...rest };
        if (timeout !== undefined) {
            settings.duration = timeout === false ? Infinity : timeout;
        }
        return kind ? notify[kind](message, settings) : notify(message, settings);
    };
    const toast = (message, options) => send(null, message, options);
    for (const kind of ["success", "error", "info", "warning"]) {
        toast[kind] = (message, options) => send(kind, message, options);
    }
    toast.clear = () => notify.dismiss();
    toast.dismiss = (id) => notify.dismiss(id);
    return toast;
}
