package com.signage.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Opens the player when the TV/box powers on or the app is updated. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("BootReceiver", "Starting player after ${intent.action}")
        val launch = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(launch)
        } catch (e: Exception) {
            // Some Android versions block this unless "Display over other apps" is allowed; try again shortly.
            SignageApp.scheduleRestart(context, 5_000)
        }
    }
}
