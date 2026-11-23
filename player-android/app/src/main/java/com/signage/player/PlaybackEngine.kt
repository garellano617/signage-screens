package com.signage.player

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
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
) {
    private val image = ImageView(activity).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        setBackgroundColor(Color.BLACK)
    }
    private val playerView = LayoutInflater.from(activity).inflate(R.layout.player_view, stage, false) as PlayerView
    private var web: WebView? = null
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
    var volume = 1f
        set(v) { field = v; player?.volume = v }

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
    }

    private suspend fun loop(playlist: Playlist?) {
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
                val ok = try {
                    when {
                        item.isVideo -> playVideo(cache.fileFor(item))
                        item.isWeb -> playWeb(item)
                        else -> playImage(cache.fileFor(item), item.duration)
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    Log.e(TAG, "Couldn't play ${item.name}", e)
                    lastError = "Couldn't play ${item.name}: ${e.message}"
                    false
                }
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

    private suspend fun playVideo(file: File): Boolean {
        val p = player ?: ExoPlayer.Builder(activity).build().also {
            player = it
            playerView.player = it
        }
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
        wv.webViewClient = WebViewClient()
        wv.visibility = View.GONE
        stage.addView(wv, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web = wv
    }

    private suspend fun playWeb(item: Item): Boolean {
        val wv = webView()
        val url = resolve(item.src)
        if (wv.url != url) wv.loadUrl(url)
        show(wv)
        player?.stop()
        delay(item.duration * 1000L)
        return true
    }

    private fun show(v: View) {
        for (child in listOf(image, playerView, idle, web)) {
            child?.visibility = if (child === v) View.VISIBLE else View.GONE
        }
    }

    companion object {
        private const val TAG = "PlaybackEngine"
    }
}
