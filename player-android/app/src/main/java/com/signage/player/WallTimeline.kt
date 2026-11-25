package com.signage.player

/** Where a video wall is in its playlist at a given portal time. All screens of the wall compute the same answer. */
object WallTimeline {
    data class Spot(val index: Int, val start: Long, val end: Long)

    /** lengths: each item's length in ms (in playlist order, all > 0). now: portal time in ms. */
    fun at(lengths: List<Long>, now: Long): Spot {
        val cycle = lengths.sum()
        var pos = ((now % cycle) + cycle) % cycle
        var i = 0
        while (pos >= lengths[i]) { pos -= lengths[i]; i++ }
        val start = now - pos
        return Spot(i, start, start + lengths[i])
    }
}
