package com.signage.player

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.media.MediaCodecList
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display

/**
 * What picture quality this TV/box can handle: 4K, 2K (1440p) or Full HD.
 * Looks at the TV panel (the display's modes), the video decoders and the memory.
 *
 * Many 4K boxes draw their apps at 1920x1080 and only show video at 4K. So the player shows video and
 * pictures on their own surfaces at the chosen resolution (see PlaybackEngine), and asks for the best
 * HDMI output mode (see bestMode).
 */
data class DeviceCaps(
    /** Largest resolution the TV panel offers (landscape). */
    val panelW: Int, val panelH: Int,
    /** Size the app window is drawn at (often 1920x1080 even on a 4K TV). */
    val uiW: Int, val uiH: Int,
    val decodes4k: Boolean, val decodes1440: Boolean,
    val ramMb: Long, val lowRam: Boolean,
) {
    /** Chosen picture height: 2160 (4K), 1440 (2K), 1080 (Full HD) or less. */
    val tier: Int get() = tierFor(minOf(panelW, panelH), decodes4k, decodes1440, ramMb, lowRam)
    val label: String get() = label(tier)
    /** True when video/pictures need their own surfaces to reach the chosen quality (the window is smaller). */
    val needsSurfaces: Boolean get() = tier > minOf(uiW, uiH)

    fun describe(): String = "$label · TV ${panelW}x$panelH · apps ${uiW}x$uiH"

    companion object {
        private const val TAG = "DeviceCaps"

        /** Pure decision, unit tested. */
        fun tierFor(panel: Int, decodes4k: Boolean, decodes1440: Boolean, ramMb: Long, lowRam: Boolean): Int = when {
            panel >= 2160 && decodes4k && ramMb >= 1500 && !lowRam -> 2160
            panel >= 1440 && (decodes1440 || decodes4k) && ramMb >= 1000 && !lowRam -> 1440
            panel >= 1080 -> 1080
            else -> maxOf(panel, 480)
        }

        fun label(tier: Int) = when {
            tier >= 2160 -> "4K"
            tier >= 1440 -> "2K"
            tier >= 1080 -> "Full HD"
            else -> "HD"
        }

        @Suppress("DEPRECATION")
        fun detect(a: Activity): DeviceCaps {
            val display = a.windowManager.defaultDisplay
            val ui = DisplayMetrics().also { display.getMetrics(it) }
            var pw = 0
            var ph = 0
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                runCatching {
                    for (m in display.supportedModes) {
                        val w = maxOf(m.physicalWidth, m.physicalHeight)
                        val h = minOf(m.physicalWidth, m.physicalHeight)
                        if (h > ph) { pw = w; ph = h }
                    }
                }
            }
            if (ph == 0) {
                val real = DisplayMetrics().also { display.getRealMetrics(it) }
                pw = maxOf(real.widthPixels, real.heightPixels)
                ph = minOf(real.widthPixels, real.heightPixels)
            }
            val am = a.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
            return DeviceCaps(
                pw, ph,
                maxOf(ui.widthPixels, ui.heightPixels), minOf(ui.widthPixels, ui.heightPixels),
                decoderSupports(3840, 2160), decoderSupports(2560, 1440),
                mem.totalMem / (1024 * 1024), am.isLowRamDevice,
            ).also { Log.i(TAG, it.toString() + " → " + it.label) }
        }

        /** A hardware H.264 or H.265 decoder that plays this size at 30 fps. */
        private fun decoderSupports(w: Int, h: Int): Boolean = runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { ci ->
                val name = ci.name.lowercase()
                !ci.isEncoder && !name.startsWith("omx.google.") && !name.startsWith("c2.android.") &&
                    ci.supportedTypes.any { t ->
                        (t.equals("video/avc", true) || t.equals("video/hevc", true)) &&
                            runCatching { ci.getCapabilitiesForType(t).videoCapabilities?.areSizeAndRateSupported(w, h, 29.0) == true }.getOrDefault(false)
                    }
            }
        }.getOrDefault(false)

        /**
         * The best HDMI output mode up to [tier], with the refresh rate closest to the current one,
         * or null when the current mode is already as good (never switches down).
         */
        fun bestMode(display: Display, tier: Int): Display.Mode? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
            return runCatching {
                val cur = display.mode
                val curH = minOf(cur.physicalWidth, cur.physicalHeight)
                val fits = display.supportedModes.filter { minOf(it.physicalWidth, it.physicalHeight) <= tier }
                val bestH = fits.maxOfOrNull { minOf(it.physicalWidth, it.physicalHeight) } ?: return null
                if (bestH <= curH) return null
                fits.filter { minOf(it.physicalWidth, it.physicalHeight) == bestH }
                    .minByOrNull { Math.abs(it.refreshRate - cur.refreshRate) }
            }.getOrNull()
        }
    }
}
