package com.signage.player

import android.content.Context
import java.util.UUID

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("signage", Context.MODE_PRIVATE)

    /** Portal address. A value baked in at build time wins until the user changes it. */
    var serverUrl: String
        get() = sp.getString("serverUrl", null) ?: BuildConfig.SERVER_URL
        set(v) = sp.edit().putString("serverUrl", v).apply()

    val deviceId: String
        get() = sp.getString("deviceId", null) ?: ("android-" + UUID.randomUUID()).also {
            sp.edit().putString("deviceId", it).apply()
        }

    var token: String?
        get() = sp.getString("token", null)
        set(v) = sp.edit().putString("token", v).apply()

    /** Last good config, so the screen keeps playing offline and after a reboot. */
    var configJson: String?
        get() = sp.getString("config", null)
        set(v) = sp.edit().putString("config", v).apply()

    /** Plays not yet sent to the portal (JSON array), kept across restarts. */
    var pendingPlays: String?
        get() = sp.getString("pendingPlays", null)
        set(v) = sp.edit().putString("pendingPlays", v).apply()

    /** Fingerprint of an app update that failed to install, so it isn't tried again. */
    var failedUpdate: String?
        get() = sp.getString("failedUpdate", null)
        set(v) = sp.edit().putString("failedUpdate", v).apply()

    var lastCrash: String?
        get() = sp.getString("lastCrash", null)
        set(v) = sp.edit().putString("lastCrash", v).commit().let { }

    /** Set when the app keeps crashing: the error shown on screen instead of restarting again. */
    var crashLoop: String?
        get() = sp.getString("crashLoop", null)
        set(v) = sp.edit().putString("crashLoop", v).commit().let { }

    /** Records a crash; true when it is the 3rd within 2 minutes (then stop restarting). */
    fun noteCrash(text: String): Boolean {
        val now = System.currentTimeMillis()
        val times = (sp.getString("crashTimes", "") ?: "").split(",").mapNotNull { it.toLongOrNull() }
            .filter { now - it < 120_000 } + now
        sp.edit().putString("crashTimes", times.takeLast(3).joinToString(",")).commit()
        val loop = times.size >= 3
        if (loop) crashLoop = text
        return loop
    }

    fun clearCrashes() {
        sp.edit().remove("crashTimes").remove("crashLoop").commit()
    }
}
