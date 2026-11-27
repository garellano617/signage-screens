package com.signage.player

import java.util.TimeZone

/**
 * The box's current time-zone offset (ms) and name for the clock widget, as JavaScript for a web page.
 * The built-in browser can keep the time zone it had when the app started, so the player passes the current one.
 */
object DeviceClock {
    fun js(): String {
        val tz = TimeZone.getDefault()
        val id = tz.id.replace("\\", "").replace("\"", "")
        return "window.deviceClock = { offset: ${tz.getOffset(System.currentTimeMillis())}, zone: \"$id\" }"
    }
}
