<template>
    <div>
        <div v-if="maintenance.strategy === 'manual'" class="timeslot">
            {{ $t("Manual") }}
        </div>
        <div v-else-if="maintenance.timeslotList.length > 0">
            <div class="timeslot">
                {{ startDateTime.format(dateFormat) }}
                <span class="to">-</span>
                {{ endDateTime.format(dateFormat) }}
            </div>
            <div class="timeslot">
                UTC{{ startDateTime.format("Z") }}
                <span v-if="startDateTime.utcOffset() !== endDateTime.utcOffset()">–UTC{{ endDateTime.format("Z") }}</span>
                <span v-if="maintenance.timezone !== 'UTC'">{{ maintenance.timezone }}</span>
            </div>
        </div>
    </div>
</template>

<script>
import dayjs from "dayjs";
import { SQL_DATETIME_FORMAT_WITHOUT_SECOND } from "../util.ts";

export default {
    props: {
        maintenance: {
            type: Object,
            required: true,
        },
    },
    computed: {
        dateFormat: () => SQL_DATETIME_FORMAT_WITHOUT_SECOND,
        startDateTime() {
            return this.inMaintenanceZone(this.maintenance.timeslotList[0].startDate);
        },
        endDateTime() {
            return this.inMaintenanceZone(this.maintenance.timeslotList[0].endDate);
        },
    },
    methods: {
        /**
         * @param {string} value Saved wall time for one-off windows, ISO instant for recurring windows.
         * @returns {import("dayjs").Dayjs} Time in the configured maintenance zone.
         */
        inMaintenanceZone(value) {
            const { strategy, timezone } = this.maintenance;
            return strategy === "single" ? dayjs.tz(value, timezone) : dayjs(value).tz(timezone);
        },
    },
};
</script>

<style lang="scss">
.timeslot {
    margin-top: 5px;
    display: inline-block;
    font-size: 14px;
    background-color: rgba(255, 255, 255, 0.5);
    border-radius: 20px;
    padding: 0 10px;
    margin-right: 5px;

    .to {
        margin: 0 6px;
    }

    .dark & {
        color: white;
        background-color: rgba(255, 255, 255, 0.1);
    }
}
</style>
