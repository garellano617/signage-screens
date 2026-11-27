package com.signage.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Build
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView

/**
 * Shows a picture on its own surface at a higher resolution than the app window (e.g. 3840x2160 on a
 * 4K TV whose apps are drawn at 1920x1080). The TV puts the surface on screen at full resolution.
 * Only used on screens that aren't rotated and aren't part of a video wall.
 */
@SuppressLint("ViewConstructor")
class HiResImage(context: Context, private val scale: () -> Float) : SurfaceView(context), SurfaceHolder.Callback {
    private var bitmap: Bitmap? = null
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private var ready = false

    init {
        holder.addCallback(this)
    }

    /** Buffer size for this view: its size times the quality scale (e.g. 2x for 4K on a 1080p window). */
    fun bufferSize(): Pair<Int, Int> {
        val k = scale()
        return Pair(maxOf(1, Math.round(width * k)), maxOf(1, Math.round(height * k)))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w > 0 && h > 0) { val (bw, bh) = bufferSize(); holder.setFixedSize(bw, bh) }
    }

    /** Draws [bmp] fitted inside the screen; returns the previously shown bitmap (to free). */
    fun show(bmp: Bitmap): Bitmap? {
        val old = bitmap
        bitmap = bmp
        if (ready) draw()
        return if (old === bmp) null else old
    }

    private fun draw() {
        val bmp = bitmap ?: return
        var canvas: Canvas? = null
        try {
            canvas = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) holder.lockHardwareCanvas() else holder.lockCanvas()
            if (canvas == null) return
            canvas.drawColor(Color.BLACK)
            val cw = canvas.width.toFloat()
            val ch = canvas.height.toFloat()
            val k = minOf(cw / bmp.width, ch / bmp.height)
            val w = bmp.width * k
            val h = bmp.height * k
            val l = ((cw - w) / 2).toInt()
            val t = ((ch - h) / 2).toInt()
            canvas.drawBitmap(bmp, null, Rect(l, t, l + Math.round(w), t + Math.round(h)), paint)
        } catch (e: Exception) {
            Log.w("HiResImage", "draw failed", e)
        } finally {
            if (canvas != null) runCatching { holder.unlockCanvasAndPost(canvas) }
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) { ready = true }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) { ready = true; draw() }
    override fun surfaceDestroyed(holder: SurfaceHolder) { ready = false }
}
