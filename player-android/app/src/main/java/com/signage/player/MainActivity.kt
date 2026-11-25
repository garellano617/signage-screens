package com.signage.player

import android.app.AlertDialog
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.PixelCopy
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.system.exitProcess

class MainActivity : ComponentActivity() {
    private lateinit var prefs: Prefs
    private lateinit var cache: MediaCache
    private lateinit var api: Api
    private lateinit var engine: PlaybackEngine

    private lateinit var root: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var stage: FrameLayout
    private lateinit var overlay: Overlay
    private var videoRegion = "full"
    private lateinit var pairing: View
    private lateinit var pairCode: TextView
    private lateinit var pairHint: TextView
    private lateinit var setup: View
    private lateinit var statusText: TextView
    private lateinit var identifyText: TextView

    private var config: Config? = null
    private var appliedOrientation = -1
    private var networkJob: Job? = null
    private var scheduleJob: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var lastNetError = ""
    private val backPresses = ArrayDeque<Long>()
    /** Proof of play waiting to be sent with the next check-in. */
    private val plays = ArrayDeque<JSONObject>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        hideSystemBars()

        prefs = Prefs(this)
        cache = MediaCache(this)
        root = findViewById(R.id.root)
        content = findViewById(R.id.content)
        stage = findViewById(R.id.stage)
        overlay = Overlay(this, findViewById(R.id.overlay), cache)
        // Keep the video layer in its area when the size changes (first layout, rotation).
        content.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) content.post { applyRegion() }
        }
        pairing = findViewById(R.id.pairing)
        pairCode = findViewById(R.id.pairCode)
        pairHint = findViewById(R.id.pairHint)
        setup = findViewById(R.id.setup)
        statusText = findViewById(R.id.statusText)
        identifyText = findViewById(R.id.identifyText)

        root.setOnLongClickListener { showMenu(); true }
        prefs.lastCrash?.let { lastNetError = it; prefs.lastCrash = null }

        if (prefs.serverUrl.isBlank()) showSetup() else start()
    }

    // ---------- startup ----------

    private fun start() {
        setup.visibility = View.GONE
        api = Api(prefs.serverUrl) { prefs.token }
        if (!::engine.isInitialized) {
            engine = PlaybackEngine(this, stage, cache, lifecycleScope, { api.resolve(it) }, { lastNetError.isEmpty() && isNetworkUp() }) { item -> widgetData(item) }
            engine.onPlayed = { item, at, sec, playlist ->
                plays.addLast(JSONObject().put("mediaId", item.mediaId).put("name", item.name).put("kind", item.kind)
                    .put("playlist", playlist).put("at", at).put("sec", sec))
                while (plays.size > 5000) plays.removeFirst()
            }
            prefs.pendingPlays?.let { saved -> runCatching { val a = JSONArray(saved); for (i in 0 until a.length()) plays.addLast(a.getJSONObject(i)) } }
            prefs.pendingPlays = null
        }
        // Offline first: play the last config we had right away.
        prefs.configJson?.let { json -> runCatching { Config.parse(json) }.getOrNull()?.takeIf { it.paired }?.let { applyConfig(it) } }
        if (config == null) engine.play(null)

        networkJob?.cancel()
        networkJob = lifecycleScope.launch { networkLoop() }
        scheduleJob?.cancel()
        scheduleJob = lifecycleScope.launch {
            while (isActive) {
                refreshSchedule()
                delay(15_000)
            }
        }
    }

    private fun showSetup() {
        setup.visibility = View.VISIBLE
        pairing.visibility = View.GONE
        val input = findViewById<EditText>(R.id.serverInput)
        val error = findViewById<TextView>(R.id.setupError)
        val save = findViewById<Button>(R.id.serverSave)
        input.setText(prefs.serverUrl.ifBlank { "http://" })
        input.setSelection(input.text.length)
        input.requestFocus()
        val submit = {
            var url = input.text.toString().trim().trimEnd('/')
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
            error.text = getString(R.string.checking)
            save.isEnabled = false
            lifecycleScope.launch {
                val ok = Api(url) { null }.healthCheck()
                save.isEnabled = true
                if (ok) {
                    if (url != prefs.serverUrl) {
                        prefs.token = null
                        prefs.configJson = null
                        config = null
                    }
                    prefs.serverUrl = url
                    error.text = ""
                    start()
                } else {
                    error.text = getString(R.string.cant_reach, url)
                }
            }
        }
        save.setOnClickListener { submit() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE || actionId == EditorInfo.IME_ACTION_GO) { submit(); true } else false
        }
    }

    // ---------- talking to the portal ----------

    private suspend fun networkLoop() {
        while (lifecycleScope.isActive) {
            var waitMs = 30_000L
            try {
                if (prefs.token == null) register()
                val batch = plays.take(500)
                val sentAt = SystemClock.elapsedRealtime()
                val hb = api.heartbeat(statusJson().put("plays", JSONArray(batch)))
                ServerClock.sample(sentAt, SystemClock.elapsedRealtime(), hb.optLong("serverTime"))
                overlay.syncClock()
                repeat(batch.size) { if (plays.isNotEmpty()) plays.removeFirst() }
                lastNetError = ""
                if (!hb.optBoolean("paired")) {
                    if (config != null) {
                        // The screen was removed in the portal.
                        config = null
                        prefs.configJson = null
                        engine.stop()
                        overlay.hide()
                    }
                    showPairing(hb.str("pairingCode"))
                    waitMs = 5_000
                } else {
                    pairing.visibility = View.GONE
                    if (config == null || config?.version != hb.str("configVersion")) fetchConfig()
                    handleCommands(hb.optJSONArray("commands"))
                }
                hb.optJSONObject("app")?.let { app -> lifecycleScope.launch { Updater.check(this@MainActivity, api, app) } }
            } catch (e: CancellationException) {
                throw e
            } catch (e: UnauthorizedException) {
                prefs.token = null
                waitMs = 1_000
            } catch (e: Exception) {
                Log.w(TAG, "Portal unreachable", e)
                lastNetError = e.message ?: e.javaClass.simpleName
                if (config == null && pairing.visibility != View.VISIBLE) {
                    showStatus(getString(R.string.cant_reach, prefs.serverUrl))
                }
                waitMs = 15_000
            }
            withTimeoutOrNull(waitMs) { wake.receive() }
        }
    }

    private suspend fun register() {
        val r = api.register(prefs.deviceId, "${Build.MANUFACTURER} ${Build.MODEL}".trim(), BuildConfig.VERSION_NAME)
        prefs.token = r.getString("token")
        if (!r.optBoolean("paired")) showPairing(r.str("pairingCode"))
    }

    /** Weather/news for a widget. The last good copy is kept on the device for when the internet is down. */
    private suspend fun widgetData(item: Item): String? {
        if (item.widgetJson?.contains("\"type\":\"weather\"") != true && item.widgetJson?.contains("\"type\":\"rss\"") != true) return null
        val file = java.io.File(filesDir, "widget-data-${item.mediaId}.json")
        return try {
            api.widgetData(item.mediaId).also { data -> withContext(Dispatchers.IO) { file.writeText(data) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            withContext(Dispatchers.IO) { if (file.exists()) file.readText() else null }
        }
    }

    @Suppress("DEPRECATION")
    private fun isNetworkUp(): Boolean = try {
        val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        cm.activeNetworkInfo?.isConnected == true
    } catch (e: Exception) {
        true
    }

    private fun showPairing(code: String) {
        hideStatus()
        pairing.visibility = View.VISIBLE
        pairCode.text = code.chunked(3).joinToString(" ")
        pairHint.text = getString(R.string.pair_hint, prefs.serverUrl)
    }

    private suspend fun fetchConfig() {
        val json = api.config()
        val c = Config.parse(json)
        if (!c.paired) return
        val missing = c.allItems.filter { !cache.isReady(it) }.distinctBy { cache.key(it) }
        missing.forEachIndexed { i, item ->
            if (engine.nowPlaying.isEmpty()) showStatus(getString(R.string.downloading, i + 1, missing.size, item.name))
            try {
                cache.download(api, item, c.allItems)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Download failed: ${item.name}", e)
                engine.lastError = e.message ?: "Download failed: ${item.name}"
            }
        }
        hideStatus()
        prefs.configJson = json
        applyConfig(c)
        cache.prune(c.allItems)
    }

    private fun applyConfig(c: Config) {
        config = c
        val s = c.screen
        engine.volume = (s?.volume ?: 100) / 100f
        if (engine.wall != c.wall) {
            engine.wall = c.wall
            engine.restart()
        }
        applyOrientation(s?.orientation ?: 0)
        videoRegion = c.videoRegion
        applyRegion()
        overlay.show(c)
        refreshSchedule()
    }

    /** Sizes the video layer to its area (e.g. left 70%) inside the content, which may be rotated. */
    private fun applyRegion() {
        stage.visibility = if (videoRegion == "off") View.GONE else View.VISIBLE
        val r = Config.REGIONS[videoRegion] ?: Config.REGIONS.getValue("full")
        val w = content.width
        val h = content.height
        if (w == 0 || h == 0) return
        val lp = stage.layoutParams as FrameLayout.LayoutParams
        lp.gravity = android.view.Gravity.TOP or android.view.Gravity.START
        lp.leftMargin = Math.round(w * r[0] / 100f)
        lp.topMargin = Math.round(h * r[1] / 100f)
        lp.width = Math.round(w * r[2] / 100f)
        lp.height = Math.round(h * r[3] / 100f)
        stage.layoutParams = lp
    }

    private fun refreshSchedule() {
        val c = config ?: return
        if (c.videoRegion == "off") { engine.stop(); return }
        val (day, minute) = Schedule.now()
        engine.play(Schedule.pick(c, day, minute))
    }

    /** Rotates the content in software, so a TV mounted in portrait works without system settings. */
    private fun applyOrientation(deg: Int) {
        if (deg == appliedOrientation && root.width > 0) return
        appliedOrientation = deg
        root.post {
            val lp = content.layoutParams as FrameLayout.LayoutParams
            if (deg == 90 || deg == 270) {
                lp.width = root.height
                lp.height = root.width
            } else {
                lp.width = FrameLayout.LayoutParams.MATCH_PARENT
                lp.height = FrameLayout.LayoutParams.MATCH_PARENT
            }
            content.layoutParams = lp
            content.rotation = deg.toFloat()
        }
    }

    private fun statusJson(): JSONObject {
        val dm = resources.displayMetrics
        return JSONObject()
            .put("playing", if (::engine.isInitialized) engine.nowPlaying else "")
            .put("playlist", if (::engine.isInitialized) engine.current?.name.orEmpty() else "")
            .put("cacheBytes", cache.bytes())
            .put("freeBytes", cache.freeBytes())
            .put("uptimeSec", SystemClock.elapsedRealtime() / 1000)
            .put("resolution", "${dm.widthPixels}x${dm.heightPixels}")
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("configVersion", config?.version.orEmpty())
            .put("update", Updater.status)
            .put("error", lastNetError.ifEmpty { if (::engine.isInitialized) engine.lastError else "" })
    }

    // ---------- remote commands ----------

    private suspend fun handleCommands(cmds: JSONArray?) {
        if (cmds == null) return
        for (i in 0 until cmds.length()) {
            when (cmds.optJSONObject(i)?.str("type")) {
                "reload" -> { fetchConfig(); engine.restart() }
                "clear_cache" -> {
                    engine.stop()
                    overlay.hide()
                    cache.clear()
                    config = null
                    fetchConfig()
                }
                "screenshot" -> { delay(300); captureScreenshot() }
                "identify" -> identify()
                "restart_app" -> restartApp()
            }
        }
    }

    private fun identify() {
        identifyText.text = config?.screen?.name ?: getString(R.string.app_name)
        identifyText.visibility = View.VISIBLE
        lifecycleScope.launch {
            delay(10_000)
            identifyText.visibility = View.GONE
        }
    }

    private fun captureScreenshot() {
        val v = window.decorView
        if (v.width == 0 || v.height == 0) return
        val bmp = Bitmap.createBitmap(v.width, v.height, Bitmap.Config.ARGB_8888)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // PixelCopy includes video (PlayerView uses a TextureView) and web content.
            PixelCopy.request(window, bmp, { result ->
                if (result == PixelCopy.SUCCESS) uploadScreenshot(bmp) else Log.w(TAG, "PixelCopy failed: $result")
            }, Handler(Looper.getMainLooper()))
        } else {
            v.draw(Canvas(bmp))
            uploadScreenshot(bmp)
        }
    }

    private fun uploadScreenshot(full: Bitmap) {
        lifecycleScope.launch {
            try {
                val jpeg = withContext(Dispatchers.Default) {
                    val scale = minOf(1f, 1280f / full.width)
                    val small = if (scale < 1f) Bitmap.createScaledBitmap(full, (full.width * scale).toInt(), (full.height * scale).toInt(), true) else full
                    ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, 75, it) }.toByteArray()
                }
                api.screenshot(jpeg)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Screenshot upload failed", e)
            }
        }
    }

    private fun restartApp() {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        SignageApp.scheduleRestart(this, 1_500)
        startActivity(intent)
        finishAffinity()
        exitProcess(0)
    }

    // ---------- status overlay ----------

    private fun showStatus(text: String) {
        statusText.text = text
        statusText.visibility = View.VISIBLE
    }

    private fun hideStatus() {
        statusText.visibility = View.GONE
    }

    // ---------- menu (long-press, MENU key, or BACK three times) ----------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (setup.visibility == View.VISIBLE) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_UP) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> { showMenu(); return true }
                KeyEvent.KEYCODE_BACK -> {
                    val now = SystemClock.elapsedRealtime()
                    backPresses.addLast(now)
                    while (backPresses.isNotEmpty() && now - backPresses.first() > 2_000) backPresses.removeFirst()
                    if (backPresses.size >= 3) { backPresses.clear(); showMenu() }
                    return true
                }
            }
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK) return true
        return super.dispatchKeyEvent(event)
    }

    private val homeAlias get() = ComponentName(this, "$packageName.HomeAlias")

    private fun kioskEnabled() =
        packageManager.getComponentEnabledSetting(homeAlias) == PackageManager.COMPONENT_ENABLED_STATE_ENABLED

    private fun showMenu() {
        val options = mutableListOf(
            getString(R.string.menu_server) to { showSetup() },
            getString(if (kioskEnabled()) R.string.menu_kiosk_off else R.string.menu_kiosk_on) to { toggleKiosk() },
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            options += getString(R.string.menu_autostart) to {
                runCatching {
                    startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                }
                Unit
            }
        }
        options += getString(R.string.menu_exit) to { finishAffinity(); exitProcess(0) }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.menu_title, BuildConfig.VERSION_NAME, prefs.deviceId.takeLast(8)))
            .setItems(options.map { it.first }.toTypedArray()) { _, which -> options[which].second() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun toggleKiosk() {
        val enable = !kioskEnabled()
        packageManager.setComponentEnabledSetting(
            homeAlias,
            if (enable) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP,
        )
        if (enable) {
            // Ask Android to pick a home app; the user chooses Signage Player and "Always".
            runCatching { startActivity(Intent(Settings.ACTION_HOME_SETTINGS)) }.onFailure {
                startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }

    // ---------- lifecycle ----------

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onResume() {
        super.onResume()
        wake.trySend(Unit)
    }

    override fun onPause() {
        super.onPause()
        // Keep unsent plays if the app is closed or the TV turns off.
        prefs.pendingPlays = if (plays.isEmpty()) null else JSONArray(plays.toList()).toString()
    }

    override fun onDestroy() {
        if (::engine.isInitialized) engine.release()
        if (::overlay.isInitialized) overlay.hide()
        super.onDestroy()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    companion object {
        private const val TAG = "SignagePlayer"
    }
}
