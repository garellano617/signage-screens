package com.signage.player

import org.junit.Assert.assertEquals
import org.junit.Test

class WallTimelineTest {
    private val lengths = listOf(10_000L, 25_500L, 4_500L) // one cycle = 40 s

    @Test fun everyScreenAgreesOnTheItemAndItsStart() {
        // 1 000 000 000 000 ms is exactly 25 000 000 cycles, so the cycle starts there.
        val base = 1_000_000_000_000L
        assertEquals(WallTimeline.Spot(0, base, base + 10_000), WallTimeline.at(lengths, base))
        assertEquals(WallTimeline.Spot(0, base, base + 10_000), WallTimeline.at(lengths, base + 9_999))
        assertEquals(WallTimeline.Spot(1, base + 10_000, base + 35_500), WallTimeline.at(lengths, base + 10_000))
        assertEquals(WallTimeline.Spot(2, base + 35_500, base + 40_000), WallTimeline.at(lengths, base + 39_000))
        // The next cycle starts over.
        assertEquals(WallTimeline.Spot(0, base + 40_000, base + 50_000), WallTimeline.at(lengths, base + 40_001))
    }

    @Test fun oneItemRepeats() {
        assertEquals(WallTimeline.Spot(0, 30_000, 45_000), WallTimeline.at(listOf(15_000L), 44_000))
    }
}
