package com.signage.player

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** The QR code on the pairing screen: opens the portal's Add screen with this TV's code filled in. */
object PairQr {
    /** Portal address the QR points to, e.g. https://signage.precom.net/#/pair/K7P2QX */
    fun url(serverUrl: String, code: String): String =
        serverUrl.trim().trimEnd('/') + "/#/pair/" + code.filter { it.isLetterOrDigit() }.uppercase()

    /** Sharp black-on-white QR bitmap: every module is a whole number of pixels (about [targetPx] wide). */
    fun bitmap(text: String, targetPx: Int = 480): Bitmap {
        val hints = mapOf(EncodeHintType.MARGIN to 2, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M)
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
        val scale = maxOf(1, targetPx / m.width)
        val w = m.width * scale
        val px = IntArray(w * w)
        for (y in 0 until w) for (x in 0 until w) {
            px[y * w + x] = if (m.get(x / scale, y / scale)) Color.BLACK else Color.WHITE
        }
        return Bitmap.createBitmap(px, w, w, Bitmap.Config.ARGB_8888)
    }
}
