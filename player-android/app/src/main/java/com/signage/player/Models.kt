package com.signage.player

import org.json.JSONArray
import org.json.JSONObject

data class Item(
    val id: Long,
    val mediaId: Long,
    val name: String,
    val kind: String,
    val src: String,
    val sha256: String?,
    val size: Long,
    /** Seconds. Used for images and web pages; videos play to their end. */
    val duration: Int,
) {
    val isWeb get() = kind == "web"
    val isVideo get() = kind == "video"
}

data class Playlist(val id: Long, val name: String, val items: List<Item>)

/** start / end are minutes after midnight. days: bit 0 = Monday … bit 6 = Sunday. */
data class Slot(val days: Int, val start: Int, val end: Int, val playlist: Playlist)

data class ScreenInfo(val name: String, val orientation: Int, val volume: Int)

data class Config(
    val paired: Boolean,
    val screen: ScreenInfo?,
    val defaultPlaylist: Playlist?,
    val slots: List<Slot>,
    val version: String,
    /** Specials / text / effects layers as JSON for the overlay page (null = none). */
    val layersJson: String? = null,
    /** Video layer area ("full", "left70", …) or "off" when the video layer is turned off. */
    val videoRegion: String = "full",
    /** Photos used by specials, cached like playlist media. */
    val specialImages: List<Item> = emptyList(),
) {
    val allItems: List<Item>
        get() = (listOfNotNull(defaultPlaylist) + slots.map { it.playlist }).flatMap { it.items } + specialImages

    companion object {
        fun parse(json: String): Config {
            val o = JSONObject(json)
            val screen = o.optJSONObject("screen")?.let {
                ScreenInfo(it.str("name"), it.optInt("orientation", 0), it.optInt("volume", 100))
            }
            val slots = mutableListOf<Slot>()
            o.optJSONArray("schedules")?.forEachObject { s ->
                val pl = s.optJSONObject("playlist")?.let(::parsePlaylist) ?: return@forEachObject
                val start = parseHm(s.str("start")) ?: return@forEachObject
                val end = parseHm(s.str("end")) ?: return@forEachObject
                slots += Slot(s.optInt("days", 127), start, end, pl)
            }
            val layers = o.optJSONObject("layers")
            val video = layers?.optJSONObject("video")
            val specialImages = mutableListOf<Item>()
            layers?.optJSONObject("specials")?.optJSONArray("items")?.forEachObject { sp ->
                sp.optJSONObject("image")?.let { specialImages += imageItem(it) }
            }
            return Config(
                paired = o.optBoolean("paired", false),
                screen = screen,
                defaultPlaylist = o.optJSONObject("defaultPlaylist")?.let(::parsePlaylist),
                slots = slots,
                version = o.str("version"),
                layersJson = layers?.toString(),
                videoRegion = when {
                    video == null -> "full"
                    !video.optBoolean("enabled", true) -> "off"
                    else -> video.str("region").ifEmpty { "full" }
                },
                specialImages = specialImages.distinctBy { it.src },
            )
        }

        /** A special's photo ({ mediaId, src, sha256, size, name }) as a cacheable item. */
        fun imageItem(img: JSONObject) = Item(
            id = 0,
            mediaId = img.optLong("mediaId"),
            name = img.str("name").ifEmpty { "special photo" },
            kind = "image",
            src = img.str("src"),
            sha256 = img.str("sha256").ifEmpty { null },
            size = img.optLong("size", 0),
            duration = 0,
        )

        /** Video layer areas in % of the screen: left, top, width, height. Same numbers as overlay.js. */
        val REGIONS = mapOf(
            "full" to floatArrayOf(0f, 0f, 100f, 100f),
            "left70" to floatArrayOf(0f, 0f, 70f, 100f),
            "right70" to floatArrayOf(30f, 0f, 70f, 100f),
            "top85" to floatArrayOf(0f, 0f, 100f, 85f),
            "left70top85" to floatArrayOf(0f, 0f, 70f, 85f),
        )

        private fun parsePlaylist(p: JSONObject): Playlist {
            val items = mutableListOf<Item>()
            p.optJSONArray("items")?.forEachObject { i ->
                items += Item(
                    id = i.optLong("id"),
                    mediaId = i.optLong("mediaId"),
                    name = i.str("name"),
                    kind = i.str("kind"),
                    src = i.str("src"),
                    sha256 = i.str("sha256").ifEmpty { null },
                    size = i.optLong("size", 0),
                    duration = i.optInt("duration", 10).coerceAtLeast(1),
                )
            }
            return Playlist(p.optLong("id"), p.str("name"), items)
        }

        fun parseHm(s: String): Int? {
            val m = Regex("^(\\d{1,2}):(\\d{2})$").find(s) ?: return null
            val h = m.groupValues[1].toInt()
            val min = m.groupValues[2].toInt()
            return if (h in 0..23 && min in 0..59) h * 60 + min else null
        }
    }
}

/** optString returns "null" for JSON null; this returns "". */
fun JSONObject.str(key: String): String = if (isNull(key)) "" else optString(key, "")

inline fun JSONArray.forEachObject(block: (JSONObject) -> Unit) {
    for (i in 0 until length()) optJSONObject(i)?.let(block)
}
