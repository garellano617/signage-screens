package com.signage.player

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * Keeps a copy of every image and video on the device so screens play without internet.
 * Everything the current playlists use is always kept, whatever its size. On top of that, up to
 * SPARE_BYTES (100 MB) of media that was removed from the playlists stays on the device, newest first,
 * so content that comes back (a weekly special, a seasonal playlist) plays at once, even offline.
 */
class MediaCache(context: Context) {
    val dir = File(context.filesDir, "media").apply { mkdirs() }

    companion object {
        const val SPARE_BYTES = 100L * 1024 * 1024
        /** Storage left free for Android and other apps; spare files are dropped first to keep it. */
        const val MIN_FREE_BYTES = 200L * 1024 * 1024
    }

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

    /** Marks a file as just used, so it is the last spare file to be dropped. */
    fun touch(item: Item) {
        if (item.isWeb || item.isWidget) return
        fileFor(item).takeIf { it.exists() }?.setLastModified(System.currentTimeMillis())
    }

    /** Downloads one file to a temp name, checks its SHA-256, then moves it into place. */
    suspend fun download(api: Api, item: Item, keep: Collection<Item>) = withContext(Dispatchers.IO) {
        val target = fileFor(item)
        if (!makeRoom(item.size, keep)) throw IOException("Not enough storage on this TV for ${item.name}")
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
            target.setLastModified(System.currentTimeMillis())
        } finally {
            c.disconnect()
            tmp.delete()
        }
    }

    private fun names(keep: Collection<Item>) = keep.filter { !it.isWeb && !it.isWidget }.map { key(it) }.toSet()

    /** Files no playlist uses now, most recently used first. */
    private fun spares(keep: Collection<Item>): List<File> {
        val names = names(keep)
        return dir.listFiles()?.filter { it.name !in names && !it.name.endsWith(".part") }?.sortedByDescending { it.lastModified() }.orEmpty()
    }

    private fun delete(f: File) {
        if (!f.delete()) Log.w("MediaCache", "Couldn't delete ${f.name}")
    }

    /** Keeps up to SPARE_BYTES of media the playlists no longer use (newest first) and deletes the rest. */
    fun prune(keep: Collection<Item>) {
        dir.listFiles()?.filter { it.name.endsWith(".part") }?.forEach { delete(it) }
        var total = 0L
        for (f in spares(keep)) {
            total += f.length()
            if (total > SPARE_BYTES) delete(f)
        }
    }

    /** Drops spare files, oldest first, until `size` bytes fit with MIN_FREE_BYTES left over. False if it still won't fit. */
    fun makeRoom(size: Long, keep: Collection<Item>): Boolean {
        val need = maxOf(size, 0L) + MIN_FREE_BYTES
        if (dir.usableSpace >= need) return true
        for (f in spares(keep).asReversed()) {
            delete(f)
            if (dir.usableSpace >= need) return true
        }
        // Without spare files left, still try if the file itself fits.
        return dir.usableSpace > maxOf(size, 0L) + 20L * 1024 * 1024
    }

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }

    fun bytes(): Long = dir.listFiles()?.sumOf { it.length() } ?: 0L

    fun freeBytes(): Long = dir.usableSpace
}
