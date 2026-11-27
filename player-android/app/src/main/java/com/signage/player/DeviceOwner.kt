package com.signage.player

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Device owner mode. Set once on the TV with
 *   adb shell dpm set-device-owner com.signage.player/.AdminReceiver
 * (the TV must have no Google/other accounts signed in). The player then:
 *  - installs app updates silently (Updater),
 *  - is the TV's home screen, so it opens by itself when the TV powers on,
 *  - locks the TV to the player (kiosk): Home and Back can't leave it; staff leave with Back ×3 → menu,
 *  - keeps the screen on and skips the lock screen,
 *  - can be rebooted, and released (device owner removed), from the portal.
 */
object DeviceOwner {
    private const val TAG = "DeviceOwner"

    private fun dpm(ctx: Context) = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
    private fun admin(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)
    private fun home(ctx: Context) = ComponentName(ctx, ctx.packageName + ".HomeAlias")

    fun isOwner(ctx: Context): Boolean = runCatching { dpm(ctx).isDeviceOwnerApp(ctx.packageName) }.getOrDefault(false)

    /** For the portal's device details. */
    fun describe(ctx: Context, kiosk: Boolean): String = when {
        !isOwner(ctx) -> "no"
        kiosk -> "yes · kiosk locked"
        else -> "yes · kiosk off"
    }

    /** Applies the owner settings; [kiosk] = home screen + locked to the player. Safe to call often. */
    fun apply(a: Activity, kiosk: Boolean) {
        if (!isOwner(a)) return
        val d = dpm(a)
        val adm = admin(a)
        runCatching { d.setLockTaskPackages(adm, arrayOf(a.packageName)) }.onFailure { Log.w(TAG, "lock task packages", it) }
        if (Build.VERSION.SDK_INT >= 23) {
            runCatching { d.setKeyguardDisabled(adm, true) }
            runCatching { d.setStatusBarDisabled(adm, kiosk) }
        }
        // Screen stays on while powered (AC, USB, wireless).
        runCatching { d.setGlobalSetting(adm, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7") }
        if (kiosk) {
            a.packageManager.setComponentEnabledSetting(home(a), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            val filter = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
            runCatching { d.addPersistentPreferredActivity(adm, filter, home(a)) }.onFailure { Log.w(TAG, "home", it) }
            runCatching { a.startLockTask() }.onFailure { Log.w(TAG, "lock task", it) }
        } else {
            runCatching { a.stopLockTask() }
            runCatching { d.clearPackagePersistentPreferredActivities(adm, a.packageName) }
            a.packageManager.setComponentEnabledSetting(home(a), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
        }
    }

    /** Restarts the TV (portal command). False when not device owner or Android is too old. */
    fun reboot(ctx: Context): Boolean {
        if (!isOwner(ctx) || Build.VERSION.SDK_INT < 24) return false
        return runCatching { dpm(ctx).reboot(admin(ctx)); true }.getOrDefault(false)
    }

    /** Removes device owner (portal command), so the app can be uninstalled or the TV used normally again. */
    @Suppress("DEPRECATION")
    fun release(a: Activity) {
        if (!isOwner(a)) return
        apply(a, kiosk = false)
        val d = dpm(a)
        if (Build.VERSION.SDK_INT >= 23) {
            runCatching { d.setKeyguardDisabled(admin(a), false) }
            runCatching { d.setStatusBarDisabled(admin(a), false) }
        }
        runCatching { d.clearDeviceOwnerApp(a.packageName) }.onFailure { Log.w(TAG, "release", it) }
    }
}
