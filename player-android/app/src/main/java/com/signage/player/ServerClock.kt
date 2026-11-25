package com.signage.player

import android.os.SystemClock

/**
 * The portal's clock, so the screens of a video wall agree on the time to within a few tens of
 * milliseconds even when their own clocks are off. Each heartbeat gives one sample: the portal's time,
 * taken halfway through the request. Based on the monotonic clock, so a change of the TV's clock
 * doesn't make the wall jump.
 */
object ServerClock {
    /** Portal time minus elapsedRealtime. Until the first heartbeat, the TV's own clock is used. */
    @Volatile private var offset = System.currentTimeMillis() - SystemClock.elapsedRealtime()
    @Volatile private var samples = 0

    fun now(): Long = SystemClock.elapsedRealtime() + offset

    /** sentAt / receivedAt: elapsedRealtime before and after the request; serverTime: the portal's reply. */
    fun sample(sentAt: Long, receivedAt: Long, serverTime: Long) {
        val rtt = receivedAt - sentAt
        if (serverTime <= 0 || rtt < 0 || rtt > 3_000) return
        val s = serverTime - (sentAt + receivedAt) / 2
        // The first sample is taken as is; later ones are smoothed so one slow request doesn't shift the wall.
        offset = if (samples == 0 || Math.abs(s - offset) > 2_000) s else (offset * 3 + s) / 4
        samples++
    }
}
