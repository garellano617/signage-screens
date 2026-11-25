package com.signage.player

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.view.View
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

    fun show(config: Config) {
        val layers = config.layersJson?.let { runCatching { JSONObject(it) }.getOrNull() }
        val needed = layers != null && listOf("specials", "text", "effects").any { layers.optJSONObject(it)?.optBoolean("enabled") == true }
        if (layers == null || !needed) { hide(); return }

        // Point each special's photo and each picture on the text layer at the downloaded copy on this device.
        val localize = { o: JSONObject ->
            o.optJSONObject("image")?.let { img ->
                val item = Config.imageItem(img)
                if (cache.isReady(item)) img.put("localSrc", Uri.fromFile(cache.fileFor(item)).toString())
            }
        }
        layers.optJSONObject("specials")?.optJSONArray("items")?.forEachObject { localize(it) }
        layers.optJSONObject("text")?.optJSONArray("blocks")?.forEachObject { localize(it) }
        layers.optJSONObject("effects")?.let { localize(it) }
        val json = layers.toString()
        if (json == shown && web != null) return
        shown = json
        val wv = web ?: create()
        wv.visibility = View.VISIBLE
        if (ready) push(json) else pending = json
    }

    fun hide() {
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
        web?.evaluateJavascript("window.clockOffset = ${ServerClock.now() - System.currentTimeMillis()}", null)
    }

    private fun push(json: String) {
        syncClock()
        // JSON is valid JavaScript except for these two characters.
        val js = json.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        web?.evaluateJavascript("window.showLayers($js)") { r -> if (r != null && r.contains("Error")) Log.w("Overlay", r) }
    }
}
