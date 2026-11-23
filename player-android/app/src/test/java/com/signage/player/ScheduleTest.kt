package com.signage.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class ScheduleTest {
    private val weekdays = 0b0011111 // Mon–Fri
    private fun hm(h: Int, m: Int = 0) = h * 60 + m

    @Test
    fun daytimeSlot() {
        assertTrue(Schedule.isActive(weekdays, hm(9), hm(17), 0, hm(9)))
        assertTrue(Schedule.isActive(weekdays, hm(9), hm(17), 4, hm(16, 59)))
        assertFalse(Schedule.isActive(weekdays, hm(9), hm(17), 0, hm(17)))
        assertFalse(Schedule.isActive(weekdays, hm(9), hm(17), 5, hm(12))) // Saturday
    }

    @Test
    fun overnightSlotBelongsToStartDay() {
        // Friday 22:00 – 06:00 runs into Saturday morning, but not into Monday morning from Sunday.
        assertTrue(Schedule.isActive(weekdays, hm(22), hm(6), 4, hm(23)))
        assertTrue(Schedule.isActive(weekdays, hm(22), hm(6), 5, hm(5, 59)))
        assertFalse(Schedule.isActive(weekdays, hm(22), hm(6), 5, hm(23)))
        assertFalse(Schedule.isActive(weekdays, hm(22), hm(6), 0, hm(3))) // Monday 3am: Sunday not selected
        assertTrue(Schedule.isActive(weekdays, hm(22), hm(6), 1, hm(3))) // Tuesday 3am: Monday selected
    }

    @Test
    fun sundayWrapsToMonday() {
        val sunday = 1 shl 6
        assertTrue(Schedule.isActive(sunday, hm(20), hm(2), 0, hm(1)))
    }

    @Test
    fun pickPrefersFirstMatchingSlot() {
        val main = Playlist(1, "Main", emptyList())
        val lunch = Playlist(2, "Lunch", emptyList())
        val late = Playlist(3, "Late", emptyList())
        val cfg = Config(true, null, main, listOf(Slot(127, hm(11), hm(14), lunch), Slot(127, hm(12), hm(23), late)), "v")
        assertEquals(lunch, Schedule.pick(cfg, 2, hm(12, 30)))
        assertEquals(late, Schedule.pick(cfg, 2, hm(15)))
        assertEquals(main, Schedule.pick(cfg, 2, hm(8)))
        assertNull(Schedule.pick(cfg.copy(defaultPlaylist = null, slots = emptyList()), 2, hm(8)))
    }

    @Test
    fun nowUsesMondayAsZero() {
        val cal = Calendar.getInstance().apply { set(2026, Calendar.NOVEMBER, 23, 14, 5) } // a Monday
        assertEquals(0 to hm(14, 5), Schedule.now(cal))
        cal.set(2026, Calendar.NOVEMBER, 22) // Sunday
        assertEquals(6, Schedule.now(cal).first)
    }

    @Test
    fun parsesTimes() {
        assertEquals(hm(9, 30), Config.parseHm("09:30"))
        assertNull(Config.parseHm("24:00"))
        assertNull(Config.parseHm("9h"))
    }
}
