package com.signage.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCapsTest {
    @Test
    fun picksTheBestQualityTheDeviceCanHandle() {
        // 4K TV, 4K decoder, 2 GB: 4K.
        assertEquals(2160, DeviceCaps.tierFor(2160, decodes4k = true, decodes1440 = true, ramMb = 2048, lowRam = false))
        // 4K TV but the box can't decode 4K: 2K.
        assertEquals(1440, DeviceCaps.tierFor(2160, decodes4k = false, decodes1440 = true, ramMb = 2048, lowRam = false))
        // 4K TV, weak box (1 GB, low-RAM): Full HD.
        assertEquals(1080, DeviceCaps.tierFor(2160, decodes4k = true, decodes1440 = true, ramMb = 1024, lowRam = true))
        // 4K decoder but only 1.2 GB: 2K.
        assertEquals(1440, DeviceCaps.tierFor(2160, decodes4k = true, decodes1440 = true, ramMb = 1200, lowRam = false))
        // 1440p monitor: 2K.
        assertEquals(1440, DeviceCaps.tierFor(1440, decodes4k = true, decodes1440 = true, ramMb = 4096, lowRam = false))
        // Full HD TV with a 4K-capable box: Full HD.
        assertEquals(1080, DeviceCaps.tierFor(1080, decodes4k = true, decodes1440 = true, ramMb = 4096, lowRam = false))
        // 720p TV: 720.
        assertEquals(720, DeviceCaps.tierFor(720, decodes4k = false, decodes1440 = false, ramMb = 1024, lowRam = false))
    }

    @Test
    fun surfacesOnlyWhenTheAppWindowIsSmallerThanTheQuality() {
        val fireTv4k = DeviceCaps(3840, 2160, 1920, 1080, decodes4k = true, decodes1440 = true, ramMb = 2048, lowRam = false)
        assertEquals("4K", fireTv4k.label)
        assertTrue(fireTv4k.needsSurfaces)
        val sony4kUi = DeviceCaps(3840, 2160, 3840, 2160, decodes4k = true, decodes1440 = true, ramMb = 3072, lowRam = false)
        assertFalse(sony4kUi.needsSurfaces)
        val hdStick = DeviceCaps(1920, 1080, 1920, 1080, decodes4k = false, decodes1440 = false, ramMb = 1024, lowRam = true)
        assertEquals("Full HD", hdStick.label)
        assertFalse(hdStick.needsSurfaces)
    }

    @Test
    fun tvsThatDrawAppsAt720StillPlayDesignVideosSharp() {
        // TCL 50" (apps and reported screen 1280x720, 4K decoder): pictures 720p, design videos up to 4K in the TV player.
        val tcl = DeviceCaps(1280, 720, 1280, 720, decodes4k = true, decodes1440 = true, ramMb = 2048, lowRam = false, isTv = true)
        assertEquals(720, tcl.tier)
        assertEquals(2160, tcl.videoTier)
        assertTrue(tcl.nativeVideo)
        assertTrue(tcl.describe().contains("design videos play up to 4K"))
        // Without a 4K decoder: Full HD.
        assertEquals(1080, DeviceCaps(1280, 720, 1280, 720, decodes4k = false, decodes1440 = false, ramMb = 1024, lowRam = false, isTv = true).videoTier)
        // A Full HD stick: nothing changes.
        assertFalse(DeviceCaps(1920, 1080, 1920, 1080, decodes4k = false, decodes1440 = false, ramMb = 1024, lowRam = true, isTv = true).nativeVideo)
        // A 720p tablet (not a TV): nothing changes.
        assertFalse(DeviceCaps(1280, 720, 1280, 720, decodes4k = true, decodes1440 = true, ramMb = 2048, lowRam = false).nativeVideo)
    }
}
