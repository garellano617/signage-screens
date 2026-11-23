package com.signage.player

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** Keeps a copy of every image and video on the device so screens play without internet. */
class MediaCache(context: Context) {
    val dir = File(context.filesDir, "media").apply { mkdirs() }

    fun key(item: Item): String {
        val ext = Regex("\\.([A-Za-z0-9]{1,5})$").find(item.src.substringBefore('?'))?.value.orEmpty().lowercase()
        return (item.sha256 ?: "m${item.mediaId}") + ext
    }

    fun fileFor(item: Item) = File(dir, key(item))

    fun isReady(item: Item): Boolean {
        if (item.isWeb || item.isWidget) return true
        val f = fileFor(item)
        return f.exists() && (item.size <= 0 || f.length() == item.size)
    }

    /** Downloads one file to a temp name, checks its SHA-256, then moves it into place. */
    suspend fun download(api: Api, item: Item) = withContext(Dispatchers.IO) {
        val target = fileFor(item)
        val tmp = File(dir, target.name + ".part")
        val c = api.open(api.resolve(item.src), auth = false)
        c.readTimeout = 60_000
        try {
            if (c.responseCode !in 200..299) throw IOException("Download of ${item.name} failed (${c.responseCode})")
            val md = MessageDigest.getInstance("SHA-256")
            c.inputStream.use { input ->
                tmp.outputStream().use { out ->
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
            val sum = md.digest().joinToString("") { "%02x".format(it) }
            if (item.sha256 != null && !sum.equals(item.sha256, ignoreCase = true)) {
                throw IOException("Download of ${item.name} was corrupted")
            }
            if (!tmp.renameTo(target)) throw IOException("Couldn't save ${item.name}")
        } finally {
            c.disconnect()
            tmp.delete()
        }
    }

    /** Deletes cached files that no playlist uses any more. */
    fun prune(keep: Collection<Item>) {
        val names = keep.filter { !it.isWeb && !it.isWidget }.map { key(it) }.toSet()
        dir.listFiles()?.forEach { f ->
            if (f.name !in names && !f.name.endsWith(".part")) {
                if (!f.delete()) Log.w("MediaCache", "Couldn't delete ${f.name}")
            }
        }
    }

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }

    fun bytes(): Long = dir.listFiles()?.sumOf { it.length() } ?: 0L

    fun freeBytes(): Long = dir.usableSpace
}
