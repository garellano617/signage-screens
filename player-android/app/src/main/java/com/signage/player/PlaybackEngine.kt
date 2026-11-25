package com.signage.player

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import kotlin.coroutines.resume

/** Loops a playlist on the stage: images and web pages for their duration, videos to their end. */
class PlaybackEngine(
    private val activity: Activity,
    private val stage: FrameLayout,
    private val cache: MediaCache,
    private val scope: CoroutineScope,
    private val resolve: (String) -> String,
    /** True while the TV has internet. Offline, web pages load from the WebView's saved copy. */
    private val online: () -> Boolean,
    /** Live data for a widget (JSON text), or null. */
    private val widgetData: suspend (Item) -> String?,
) {
    private var widgetWeb: WebView? = null
    private var widgetReady = false
    private val image = ImageView(activity).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(Color.BLACK)
    }
    private val playerView = LayoutInflater.from(activity).inflate(R.layout.player_view, stage, false) as PlayerView
    private var web: WebView? = null
    private var webFailed = false
    private val idle = TextView(activity).apply {
        setTextColor(Color.parseColor("#9aa4b5"))
        textSize = 22f
        gravity = Gravity.CENTER
        text = activity.getString(R.string.no_content)
    }
    private var player: ExoPlayer? = null
    private var job: Job? = null
    private var currentBitmap: Bitmap? = null

    var current: Playlist? = null
        private set
    var nowPlaying = ""
        private set
    var lastError = ""
    /** Called after each item finishes: item, start time (ms), seconds shown, playlist name. For reports. */
    var onPlayed: ((Item, Long, Int, String) -> Unit)? = null
    var volume = 1f
        set(v) { field = v; player?.volume = v }
    /** Set when this screen is part of a video wall: it shows its part of the picture, in step with the others. */
    var wall: Wall? = null
    private val videoLengths = HashMap<String, Long>()

    init {
        val mp = FrameLayout.LayoutParams.MATCH_PARENT
        for (v in listOf(image, playerView, idle)) {
            stage.addView(v, FrameLayout.LayoutParams(mp, mp))
            v.visibility = View.GONE
        }
    }

    /** Starts the playlist, unless it's already the one playing. null shows "no content". */
    fun play(playlist: Playlist?) {
        if (playlist == current && job?.isActive == true) return
        job?.cancel()
        current = playlist
        job = scope.launch { loop(playlist) }
    }

    fun restart() {
        val p = current
        current = null
        play(p)
    }

    fun stop() {
        job?.cancel()
        current = null
        player?.stop()
        show(idle)
    }

    fun release() {
        job?.cancel()
        player?.release()
        player = null
        web?.destroy()
        web = null
        widgetWeb?.destroy()
        widgetWeb = null
    }

    private suspend fun loop(playlist: Playlist?) {
        wall?.let { wallLoop(playlist, it); return }
        layoutWall(null)
        while (scope.isActive) {
            val items = playlist?.items.orEmpty().filter { cache.isReady(it) }
            if (items.isEmpty()) {
                nowPlaying = ""
                player?.stop()
                idle.text = activity.getString(if (playlist == null) R.string.no_content else R.string.waiting_for_downloads)
                show(idle)
                delay(5_000)
                continue
            }
            for (item in items) {
                if (!cache.isReady(item)) continue
                nowPlaying = item.name
                val startedAt = System.currentTimeMillis()
                val ok = try {
                    when {
                        item.isVideo -> playVideo(cache.fileFor(item))
                        item.isWeb -> playWeb(item)
                        item.isWidget -> playWidget(item)
                        else -> playImage(cache.fileFor(item), item.duration)
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    Log.e(TAG, "Couldn't play ${item.name}", e)
                    lastError = "Couldn't play ${item.name}: ${e.message}"
                    false
                }
                if (ok) cache.touch(item)
                if (ok) onPlayed?.invoke(item, startedAt, ((System.currentTimeMillis() - startedAt) / 1000).toInt(), playlist?.name.orEmpty())
                // Don't spin through a playlist where everything fails.
                if (!ok) delay(2_000)
            }
        }
    }

    private suspend fun playImage(file: File, seconds: Int): Boolean {
        val w = stage.width.takeIf { it > 0 } ?: 1920
        val h = stage.height.takeIf { it > 0 } ?: 1080
        val bmp = withContext(Dispatchers.IO) { decodeScaled(file, w, h) } ?: run {
            lastError = "Couldn't open image ${file.name}"
            return false
        }
        val old = currentBitmap
        image.setImageBitmap(bmp)
        currentBitmap = bmp
        show(image)
        player?.stop()
        if (old != null && old !== bmp) old.recycle()
        delay(seconds * 1000L)
        return true
    }

    private fun decodeScaled(file: File, reqW: Int, reqH: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= reqW && bounds.outHeight / (sample * 2) >= reqH) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun ensurePlayer(): ExoPlayer = player ?: ExoPlayer.Builder(activity).build().also {
        player = it
        playerView.player = it
    }

    // ---------- video wall ----------

    /**
     * Sizes the picture to the whole wall and shifts it so this screen shows only its own tile.
     * The stage clips everything outside the screen. null = normal, one screen.
     */
    private fun layoutWall(w: Wall?) {
        val sw = stage.width
        val sh = stage.height
        for (v in listOf<View>(image, playerView)) {
            val lp = v.layoutParams as FrameLayout.LayoutParams
            lp.gravity = Gravity.TOP or Gravity.START
            if (w == null || sw == 0 || sh == 0) {
                lp.width = FrameLayout.LayoutParams.MATCH_PARENT
                lp.height = FrameLayout.LayoutParams.MATCH_PARENT
                v.translationX = 0f
                v.translationY = 0f
            } else {
                val gap = w.bezel / 100f * sw
                lp.width = Math.round(w.cols * sw + (w.cols - 1) * gap)
                lp.height = Math.round(w.rows * sh + (w.rows - 1) * gap)
                v.translationX = -(w.col * (sw + gap))
                v.translationY = -(w.row * (sh + gap))
            }
            v.layoutParams = lp
        }
        val fill = w != null && w.fit != "fit"
        image.scaleType = if (fill) ImageView.ScaleType.CENTER_CROP else ImageView.ScaleType.FIT_CENTER
        playerView.resizeMode = if (fill) AspectRatioFrameLayout.RESIZE_MODE_ZOOM else AspectRatioFrameLayout.RESIZE_MODE_FIT
    }

    /** Length of a video file in ms. Every screen has the same file, so they all get the same number. */
    private suspend fun videoLengthMs(file: File, fallback: Long): Long = videoLengths[file.name] ?: withContext(Dispatchers.IO) {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(file.path)
            r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } catch (e: Exception) {
            null
        } finally {
            runCatching { r.release() }
        }
    }?.also { videoLengths[file.name] = it } ?: fallback

    /**
     * Video wall playback. The playlist repeats on a timeline shared by all screens of the wall:
     * at portal time T, every screen is at the same item and the same moment in it.
     * Pictures and videos only; web pages and widgets are skipped.
     */
    private suspend fun wallLoop(playlist: Playlist?, w: Wall) {
        while (scope.isActive) {
            val items = playlist?.items.orEmpty().filter { (it.isVideo || it.kind == "image") && cache.isReady(it) }
            if (items.isEmpty()) {
                nowPlaying = ""
                player?.stop()
                idle.text = activity.getString(if (playlist == null) R.string.no_content else R.string.waiting_for_downloads)
                show(idle)
                delay(5_000)
                continue
            }
            val lengths = items.map { (if (it.isVideo) videoLengthMs(cache.fileFor(it), it.duration * 1000L) else it.duration * 1000L).coerceAtLeast(1_000L) }
            val spot = WallTimeline.at(lengths, ServerClock.now())
            val item = items[spot.index]
            val start = spot.start
            val end = spot.end
            nowPlaying = item.name
            layoutWall(w)
            val ok = try {
                if (item.isVideo) playWallVideo(cache.fileFor(item), start, end) else playWallImage(cache.fileFor(item), w)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                Log.e(TAG, "Couldn't play ${item.name} on the wall", e)
                lastError = "Couldn't play ${item.name}: ${e.message}"
                false
            }
            if (ok) {
                cache.touch(item)
                onPlayed?.invoke(item, System.currentTimeMillis() - (ServerClock.now() - start), ((end - start) / 1000).toInt(), playlist?.name.orEmpty())
            }
            // Wait for the item's end on the shared timeline, so the next one starts together.
            val left = end - ServerClock.now()
            if (left > 0) delay(left)
        }
    }

    private suspend fun playWallImage(file: File, w: Wall): Boolean {
        val sw = stage.width.takeIf { it > 0 } ?: 1920
        val sh = stage.height.takeIf { it > 0 } ?: 1080
        // Decode for the whole wall's size, but no bigger than about 4K, to keep memory in check.
        var reqW = w.cols * sw
        var reqH = w.rows * sh
        val scale = minOf(1f, 3840f / maxOf(reqW, reqH))
        reqW = (reqW * scale).toInt()
        reqH = (reqH * scale).toInt()
        val bmp = withContext(Dispatchers.IO) { decodeScaled(file, reqW, reqH) } ?: run {
            lastError = "Couldn't open image ${file.name}"
            return false
        }
        val old = currentBitmap
        image.setImageBitmap(bmp)
        currentBitmap = bmp
        show(image)
        player?.stop()
        if (old != null && old !== bmp) old.recycle()
        return true
    }

    /**
     * Plays a video on the shared timeline: starts at the right moment, then keeps checking the
     * position against the portal clock and nudges the speed (or jumps) to stay with the other screens.
     */
    private suspend fun playWallVideo(file: File, start: Long, end: Long): Boolean {
        val length = end - start
        // Load a little ahead of where the wall is, then start exactly when the wall gets there.
        val target = ServerClock.now() - start + 800
        if (target >= length - 500) return true
        val p = ensurePlayer()
        p.volume = volume
        p.repeatMode = Player.REPEAT_MODE_OFF
        p.setPlaybackSpeed(1f)
        p.playWhenReady = false
        p.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)), target)
        p.prepare()
        var failed = false
        val listener = object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                lastError = "Video ${file.name}: ${error.errorCodeName}"
                failed = true
            }
        }
        p.addListener(listener)
        try {
            withTimeoutOrNull(5_000) { while (p.playbackState != Player.STATE_READY && !failed) delay(20) }
            if (failed) return false
            val wait = start + target - ServerClock.now()
            if (wait > 0) delay(wait) else p.seekTo(ServerClock.now() - start)
            show(playerView)
            p.play()
            while (ServerClock.now() < end - 150) {
                if (failed) return false
                if (p.playbackState == Player.STATE_ENDED) break
                val expected = ServerClock.now() - start
                val diff = p.currentPosition - expected
                when {
                    Math.abs(diff) > 400 -> { p.setPlaybackSpeed(1f); p.seekTo((expected + 120).coerceIn(0, length)) }
                    Math.abs(diff) > 25 -> p.setPlaybackSpeed((1f - diff / 2000f).coerceIn(0.95f, 1.05f))
                    else -> p.setPlaybackSpeed(1f)
                }
                delay(500)
            }
            return true
        } finally {
            p.removeListener(listener)
            p.setPlaybackSpeed(1f)
        }
    }

    private suspend fun playVideo(file: File): Boolean {
        val p = ensurePlayer()
        p.volume = volume
        p.repeatMode = Player.REPEAT_MODE_OFF
        p.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
        p.prepare()
        p.play()
        show(playerView)
        var ok = true
        // Safety limit so a stuck video can't freeze the screen forever.
        withTimeoutOrNull(6 * 60 * 60 * 1000L) {
            suspendCancellableCoroutine { cont ->
                val listener = object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_ENDED) {
                            p.removeListener(this)
                            if (cont.isActive) cont.resume(Unit)
                        }
                    }

                    override fun onPlayerError(error: PlaybackException) {
                        p.removeListener(this)
                        lastError = "Video ${file.name}: ${error.errorCodeName}"
                        ok = false
                        if (cont.isActive) cont.resume(Unit)
                    }
                }
                p.addListener(listener)
                cont.invokeOnCancellation { activity.runOnUiThread { p.removeListener(listener) } }
            }
        }
        return ok
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun webView(): WebView = web ?: WebView(activity).also { wv ->
        wv.setBackgroundColor(Color.BLACK)
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.mediaPlaybackRequiresUserGesture = false
        wv.settings.loadWithOverviewMode = true
        wv.settings.useWideViewPort = true
        wv.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) { webLoad?.let { if (it.isActive) it.complete(true) } }

            @Suppress("DEPRECATION")
            override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
                // Only the page itself (this callback is for the main frame); a missing picture on it doesn't count.
                webLoad?.let { if (it.isActive) it.complete(false) }
            }
        }
        wv.visibility = View.GONE
        stage.addView(wv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web = wv
    }

    private var webLoad: kotlinx.coroutines.CompletableDeferred<Boolean>? = null

    /**
     * Shows a web page. Online it loads normally (and the WebView keeps a copy). Offline it loads the saved
     * copy; a page that was never saved is skipped, so the screen shows the next item instead of an error page.
     */
    private suspend fun playWeb(item: Item): Boolean {
        val wv = webView()
        val url = resolve(item.src)
        val isOnline = online()
        wv.settings.cacheMode = if (isOnline) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
        if (wv.url != url || webFailed) {
            val done = kotlinx.coroutines.CompletableDeferred<Boolean>()
            webLoad = done
            wv.loadUrl(url)
            webFailed = !(withTimeoutOrNull(if (isOnline) 20_000L else 8_000L) { done.await() } ?: isOnline)
            webLoad = null
            if (webFailed) {
                lastError = if (isOnline) "Web page ${item.name} didn't load" else "Web page ${item.name} isn't saved on this TV (no internet)"
                wv.stopLoading()
                return false
            }
        }
        show(wv)
        player?.stop()
        delay(item.duration * 1000L)
        return true
    }

    /** Widgets are drawn by the bundled widget page (assets/widget.html), the same code as the portal preview. */
    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun playWidget(item: Item): Boolean {
        val json = item.widgetJson ?: return false
        val wv = widgetWeb ?: WebView(activity).also { w ->
            w.setBackgroundColor(Color.BLACK)
            w.isFocusable = false
            w.settings.javaScriptEnabled = true
            w.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { widgetReady = true }
            }
            w.visibility = View.GONE
            stage.addView(w, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            w.loadUrl("file:///android_asset/widget.html")
            widgetWeb = w
        }
        val data = widgetData(item) ?: "null"
        // Wait (briefly) for the page to load the first time.
        var waited = 0
        while (!widgetReady && waited < 5000) { delay(100); waited += 100 }
        val js = "window.showWidget($json, $data)".replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        wv.evaluateJavascript(js, null)
        show(wv)
        player?.stop()
        delay(item.duration * 1000L)
        return true
    }

    private fun show(v: View) {
        for (child in listOf(image, playerView, idle, web, widgetWeb)) {
            child?.visibility = if (child === v) View.VISIBLE else View.GONE
        }
    }

    companion object {
        private const val TAG = "PlaybackEngine"
    }
}
