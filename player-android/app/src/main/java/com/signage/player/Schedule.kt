package com.signage.player

import java.util.Calendar

object Schedule {
    /**
     * dayIndex: 0 = Monday … 6 = Sunday. minute: minutes after midnight.
     * A slot whose end is before its start runs overnight; it belongs to the day it starts on.
     */
    fun isActive(days: Int, start: Int, end: Int, dayIndex: Int, minute: Int): Boolean {
        fun on(d: Int) = (days and (1 shl ((d + 7) % 7))) != 0
        return if (start < end) {
            on(dayIndex) && minute >= start && minute < end
        } else {
            (on(dayIndex) && minute >= start) || (on(dayIndex - 1) && minute < end)
        }
    }

    /** First matching slot wins; otherwise the screen's main playlist. */
    fun pick(config: Config, dayIndex: Int, minute: Int): Playlist? =
        config.slots.firstOrNull { isActive(it.days, it.start, it.end, dayIndex, minute) }?.playlist
            ?: config.defaultPlaylist

    /** (dayIndex with Monday = 0, minute of day) in the device's time zone. */
    fun now(cal: Calendar = Calendar.getInstance()): Pair<Int, Int> {
        // Calendar: SUNDAY = 1, MONDAY = 2 … SATURDAY = 7
        val dayIndex = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7
        return dayIndex to cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
    }
}
