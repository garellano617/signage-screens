package com.signage.player

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import org.json.JSONArray

/**
 * Videos placed on a design, played by the TV's own video player (full resolution, e.g. 1080p or 4K) instead of
 * inside the web page. Many TVs (TCL and others) draw apps at 1280x720 but play video at the screen's full
 * resolution. Each video sits under the see-through page, at the box overlay.js reports (SignageNative.videos).
 */
class NativeVideos(private val activity: Activity, private val layer: FrameLayout) {
    private class Entry(val view: PlayerView, val player: ExoPlayer, val src: String) { var sync = false }

    private val entries = HashMap<String, Entry>()
    private val handler = Handler(Looper.getMainLooper())
    private val syncTick = object : Runnable {
        override fun run() {
            entries.values.forEach { if (it.sync) syncToClock(it.player) }
            if (entries.isNotEmpty()) handler.postDelayed(this, 3000)
        }
    }

    /** List from overlay.js: [{ id, src, fit, sound, sync, show, x, y, w, h }] in screen pixels. */
    fun update(json: String) {
        val list = runCatching { JSONArray(json) }.getOrNull() ?: return
        val seen = HashSet<String>()
        list.forEachObject { o ->
            val id = o.str("id")
            val src = o.str("src")
            if (id.isEmpty() || src.isEmpty()) return@forEachObject
            seen += id
            val e = entries[id] ?: create(src).also { entries[id] = it }
            e.sync = o.optBoolean("sync")
            e.player.volume = if (o.optBoolean("sound")) 1f else 0f
            e.view.resizeMode = if (o.str("fit") == "contain") AspectRatioFrameLayout.RESIZE_MODE_FIT else AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            val lp = (e.view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(1, 1)
            lp.width = o.optInt("w").coerceAtLeast(1)
            lp.height = o.optInt("h").coerceAtLeast(1)
            lp.leftMargin = o.optInt("x")
            lp.topMargin = o.optInt("y")
            e.view.layoutParams = lp
            e.view.visibility = if (o.optBoolean("show")) View.VISIBLE else View.INVISIBLE
        }
        (entries.keys - seen).forEach { release(it) }
        handler.removeCallbacks(syncTick)
        if (entries.values.any { it.sync }) handler.postDelayed(syncTick, 1000)
    }

    fun clear() {
        handler.removeCallbacks(syncTick)
        entries.keys.toList().forEach { release(it) }
    }

    private fun create(src: String): Entry {
        val view = LayoutInflater.from(activity).inflate(R.layout.player_view_surface, layer, false) as PlayerView
        val player = ExoPlayer.Builder(activity).build()
        player.repeatMode = Player.REPEAT_MODE_ONE
        player.volume = 0f
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) { Log.w(TAG, "video failed: $src", error) }
        })
        view.player = player
        player.setMediaItem(MediaItem.fromUri(Uri.parse(src)))
        player.prepare()
        player.playWhenReady = true
        layer.addView(view, FrameLayout.LayoutParams(1, 1))
        return Entry(view, player, src)
    }

    private fun release(id: String) {
        val e = entries.remove(id) ?: return
        e.view.player = null
        e.player.release()
        layer.removeView(e.view)
    }

    /** Video wall: every TV shows the same moment of the video (the portal's clock), within a quarter second. */
    private fun syncToClock(p: ExoPlayer) {
        val d = p.duration
        if (d == C.TIME_UNSET || d <= 0) return
        val want = ServerClock.now() % d
        var off = p.currentPosition - want
        if (Math.abs(off) > d / 2) off -= d * (if (off > 0) 1 else -1)
        if (Math.abs(off) > 250) p.seekTo(want)
    }

    companion object { private const val TAG = "NativeVideos" }
}
