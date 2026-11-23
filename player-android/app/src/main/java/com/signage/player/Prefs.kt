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

    var lastCrash: String?
        get() = sp.getString("lastCrash", null)
        set(v) = sp.edit().putString("lastCrash", v).commit().let { }
}
