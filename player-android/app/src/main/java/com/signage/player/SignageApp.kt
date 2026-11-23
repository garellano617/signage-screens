package com.signage.player

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlin.system.exitProcess

class SignageApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // A screen on a wall has nobody to tap "reopen": restart ourselves after a crash.
        Thread.setDefaultUncaughtExceptionHandler { _, e ->
            Log.e("SignageApp", "Crash, restarting", e)
            runCatching { Prefs(this).lastCrash = "App crashed: ${e.javaClass.simpleName}: ${e.message}".take(400) }
            scheduleRestart(this, 3_000)
            android.os.Process.killProcess(android.os.Process.myPid())
            exitProcess(10)
        }
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
