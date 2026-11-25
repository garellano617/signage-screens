package com.signage.player

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Automatic app updates. The portal's heartbeat names the newest player app by its SHA-256 fingerprint.
 * When it differs from this app's own file, the new one is downloaded, checked and installed.
 *
 * - Device owner (set once with adb, see README) or Android 12+ updating itself: installs silently.
 * - Otherwise Android asks on the TV ("Do you want to install this update?"); someone presses Install.
 * Android only accepts the update when it is signed with the same key and has a higher version number,
 * so a wrong file can't replace the app. A file that fails is not tried again.
 */
object Updater {
    private const val TAG = "Updater"
    private const val RETRY_MS = 30 * 60 * 1000L

    /** Shown in the portal under "App updates". */
    @Volatile var status = ""
    @Volatile private var busy = false
    private var lastAttempt = 0L
    private var ownSha: String? = null

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Called after each heartbeat with its "app" field. */
    suspend fun check(ctx: Context, api: Api, app: JSONObject?) {
        if (app == null || busy) return
        val sha = app.optString("sha256").lowercase()
        if (!Regex("^[0-9a-f]{64}$").matches(sha)) return
        val own = ownSha ?: withContext(Dispatchers.IO) { sha256(File(ctx.applicationInfo.sourceDir)) }.also { ownSha = it }
        val prefs = Prefs(ctx)
        if (sha == own) {
            status = "Up to date (${BuildConfig.VERSION_NAME})"
            prefs.failedUpdate = null
            return
        }
        if (sha == prefs.failedUpdate) return
        val now = System.currentTimeMillis()
        if (now - lastAttempt < RETRY_MS) return
        lastAttempt = now
        busy = true
        try {
            status = "Downloading an update…"
            val file = download(ctx, api, api.resolve(app.optString("url", "/download/player.apk")), sha)
            status = "Installing the update…"
            install(ctx, file, sha)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Update failed", e)
            status = "Update failed: ${e.message ?: e.javaClass.simpleName}. Trying again in 30 minutes."
        } finally {
            busy = false
        }
    }

    private suspend fun download(ctx: Context, api: Api, url: String, sha: String): File = withContext(Dispatchers.IO) {
        val dir = File(ctx.cacheDir, "update").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, "player.apk")
        val c = api.open(url, auth = false)
        c.readTimeout = 60_000
        try {
            if (c.responseCode !in 200..299) throw IOException("download returned ${c.responseCode}")
            val md = MessageDigest.getInstance("SHA-256")
            c.inputStream.use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
            val got = md.digest().joinToString("") { "%02x".format(it) }
            if (got != sha) throw IOException("the download was incomplete")
            file
        } finally {
            c.disconnect()
        }
    }

    private suspend fun install(ctx: Context, file: File, sha: String) = withContext(Dispatchers.IO) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        val session = installer.openSession(id)
        try {
            session.openWrite("player.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val result = Intent(ctx, UpdateReceiver::class.java).putExtra("sha", sha)
            // The system adds the result to this intent, so it must be mutable.
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(ctx, id, result, flags).intentSender)
        } catch (e: Exception) {
            session.abandon()
            throw e
        } finally {
            session.close()
        }
        file.delete()
    }
}

/** Result of an install: asks on screen when Android needs a person to confirm, remembers files that can't install. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val sha = intent.getStringExtra("sha")
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()
        when (val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                Updater.status = "Update ready: press Install on the TV (or set the player up as device owner for silent updates)."
                try {
                    confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
                } catch (e: Exception) {
                    Log.w("UpdateReceiver", "Couldn't show the install prompt", e)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Updater.status = "Updated, restarting…"
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.status = "Update cancelled on the TV. Asking again in 30 minutes."
            else -> {
                // Wrong signing key, older version, damaged file…: don't try this same file again.
                if (sha != null) Prefs(ctx).failedUpdate = sha
                Updater.status = "Update couldn't install (code $st${if (msg.isNotEmpty()) ": $msg" else ""}). Upload a newer build signed with the same key."
            }
        }
    }
}

/** Lets the player be made "device owner" with adb, so updates install without anyone pressing Install. */
class AdminReceiver : android.app.admin.DeviceAdminReceiver()
