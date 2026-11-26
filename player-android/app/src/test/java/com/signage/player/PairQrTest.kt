package com.signage.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PairQrTest {
    @Test
    fun urlOpensThePortalPairPage() {
        assertEquals("https://signage.precom.net/#/pair/K7P2QX", PairQr.url("https://signage.precom.net/", "k7p 2qx"))
        assertEquals("http://192.168.1.10:3100/#/pair/ABC234", PairQr.url(" http://192.168.1.10:3100 ", "ABC234"))
    }
}
