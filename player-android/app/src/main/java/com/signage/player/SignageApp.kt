package com.signage.player

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.system.exitProcess

class SignageApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // A screen on a wall has nobody to tap "reopen": restart ourselves after a crash.
        // After 3 crashes within 2 minutes we stop restarting; the next start shows the error on screen instead.
        Thread.setDefaultUncaughtExceptionHandler { _, e ->
            Log.e("SignageApp", "Crash, restarting", e)
            val prefs = runCatching { Prefs(this) }.getOrNull()
            val text = "${e.javaClass.simpleName}: ${e.message}".take(400)
            runCatching { prefs?.lastCrash = "App crashed: $text" }
            val loop = runCatching { prefs?.noteCrash(text) ?: false }.getOrDefault(false)
            runCatching { report(prefs, e, loop) }
            if (!loop) scheduleRestart(this, 3_000)
            android.os.Process.killProcess(android.os.Process.myPid())
            exitProcess(10)
        }
    }

    /** Tells the portal what went wrong (works before pairing too), waiting at most 3 seconds. */
    private fun report(prefs: Prefs?, e: Throwable, loop: Boolean) {
        val server = prefs?.serverUrl?.trimEnd('/') ?: return
        if (server.isBlank()) return
        val trace = Log.getStackTraceString(e).lineSequence().take(25).joinToString("\n")
        val body = JSONObject()
            .put("deviceId", prefs.deviceId)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("android", "${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})")
            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("error", "${e.javaClass.name}: ${e.message}".take(500))
            .put("trace", trace.take(4000))
            .put("stopped", loop)
            .toString()
        val t = Thread {
            runCatching {
                val c = URL("$server/api/player/crash").openConnection() as HttpURLConnection
                c.connectTimeout = 2500; c.readTimeout = 2500
                c.requestMethod = "POST"; c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
                c.responseCode
                c.disconnect()
            }
        }
        t.start()
        t.join(3_000)
    }

    companion object {
        fun scheduleRestart(ctx: Context, delayMs: Long) {
            val intent = Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            val pi = PendingIntent.getActivity(
                ctx, 1, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_CANCEL_CURRENT,
            )
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            am.set(AlarmManager.RTC, System.currentTimeMillis() + delayMs, pi)
        }
    }
}
