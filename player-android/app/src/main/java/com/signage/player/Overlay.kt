package com.signage.player

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * Specials, text and effects layers, drawn by the same overlay.js the portal uses for its live preview.
 * The page (assets/player.html) is transparent, so the video layer underneath shows through.
 */
class Overlay(private val activity: Activity, private val host: FrameLayout, private val cache: MediaCache) {
    private var web: WebView? = null
    private var ready = false
    private var pending: String? = null
    private var shown: String? = null
    private var lastConfig: Config? = null
    /** Live data (weather, news) for widgets placed on the design, by widget id. */
    private val widgetData = HashMap<Long, String>()
    /** Videos on the design played by the TV's own video player, under the page (see NativeVideos). */
    private val videoLayer = FrameLayout(activity).also {
        host.addView(it, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }
    private val nativeVideos = NativeVideos(activity, videoLayer)

    /**
     * True on TVs that draw apps at a lower resolution than they play video (e.g. apps 720p): the design's videos
     * then play in the TV's own video player at full quality. Not for rotated screens (that player can't rotate).
     */
    var nativeVideo = false
        set(v) {
            if (field == v) return
            field = v
            shown = null
            lastConfig?.let { show(it) }
        }

    /** Widgets on the design that need live data (weather, news), as items for MainActivity.widgetData. */
    fun dataWidgets(config: Config): List<Item> {
        val layers = config.layersJson?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return emptyList()
        val out = mutableListOf<Item>()
        layers.optJSONObject("text")?.optJSONArray("blocks")?.forEachObject { b ->
            val w = b.optJSONObject("widget") ?: return@forEachObject
            if (b.str("kind") == "widget" && (w.str("type") == "weather" || w.str("type") == "rss"))
                out += Item(0, b.optLong("mediaId"), b.str("widgetName"), "widget", "widget:" + b.optLong("mediaId"), null, 0, 0, w.toString())
        }
        return out.distinctBy { it.mediaId }
    }

    /** New live data for a widget: redraws the design if it changed. */
    fun setWidgetData(mediaId: Long, data: String?) {
        if (data == null || widgetData[mediaId] == data) return
        widgetData[mediaId] = data
        lastConfig?.let { show(it) }
    }

    fun show(config: Config) {
        lastConfig = config
        val layers = config.layersJson?.let { runCatching { JSONObject(it) }.getOrNull() }
        val needed = layers != null && listOf("specials", "text", "effects").any { layers.optJSONObject(it)?.optBoolean("enabled") == true }
        if (layers == null || !needed) { hide(); return }

        localizeImages(layers, cache)
        // Widgets' live data goes into the layers (overlay.js reads b.widgetData).
        layers.optJSONObject("text")?.optJSONArray("blocks")?.forEachObject { b ->
            if (b.str("kind") == "widget") widgetData[b.optLong("mediaId")]?.let { d -> runCatching { b.put("widgetData", org.json.JSONTokener(d).nextValue()) } }
        }
        val json = layers.toString()
        if (json == shown && web != null) return
        shown = json
        val wv = web ?: create()
        wv.visibility = View.VISIBLE
        if (ready) push(json) else pending = json
    }

    fun hide() {
        nativeVideos.clear()
        web?.let {
            host.removeView(it)
            it.destroy()
        }
        web = null
        ready = false
        shown = null
        pending = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun create(): WebView = WebView(activity).also { wv ->
        wv.setBackgroundColor(Color.TRANSPARENT)
        wv.isFocusable = false
        wv.isFocusableInTouchMode = false
        wv.settings.javaScriptEnabled = true
        // Needed to show special photos stored in the app's files folder.
        wv.settings.allowFileAccess = true
        // Videos placed on a design start on their own (no tap needed on a TV).
        wv.settings.mediaPlaybackRequiresUserGesture = false
        // Draw the whole page at full resolution (no blurry low-resolution tiles while effects animate).
        if (android.os.Build.VERSION.SDK_INT >= 23) wv.settings.offscreenPreRaster = true
        wv.settings.textZoom = 100
        // Lets the page remember settings on this box (e.g. a lower effects resolution on a slow box).
        wv.settings.domStorageEnabled = true
        wv.addJavascriptInterface(object {
            @JavascriptInterface
            fun videos(json: String) { activity.runOnUiThread { if (web === wv) nativeVideos.update(json) } }
        }, "SignageNative")
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                ready = true
                pending?.let { push(it) }
                pending = null
            }
        }
        wv.loadUrl("file:///android_asset/player.html")
        host.addView(wv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web = wv
    }

    /** Tells the page the difference between the portal clock and this TV clock (for video wall effects). */
    fun syncClock() {
        web?.evaluateJavascript("window.clockOffset = ${ServerClock.now() - System.currentTimeMillis()}; " + DeviceClock.js(), null)
    }

    private fun push(json: String) {
        syncClock()
        web?.evaluateJavascript("window.nativeVideo = $nativeVideo;", null)
        // JSON is valid JavaScript except for these two characters.
        val js = json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        web?.evaluateJavascript("window.showLayers($js)") { r -> if (r != null && r.contains("Error")) Log.w("Overlay", r) }
    }

    companion object {
        /** Points each special's photo, each picture on the text layer and the plane's logo at the downloaded copy on this device. */
        fun localizeImages(layers: JSONObject, cache: MediaCache) {
            val localize = { o: JSONObject ->
                o.optJSONObject("image")?.let { img ->
                    val item = Config.imageItem(img)
                    if (cache.isReady(item)) img.put("localSrc", Uri.fromFile(cache.fileFor(item)).toString())
                }
            }
            layers.optJSONObject("specials")?.optJSONArray("items")?.forEachObject { localize(it) }
            layers.optJSONObject("text")?.optJSONArray("blocks")?.forEachObject { localize(it) }
            layers.optJSONObject("effects")?.let { localize(it) }
        }
    }
}
