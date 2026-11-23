package com.signage.player

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class UnauthorizedException : IOException("Device not recognised by the portal")

/** Talks to the portal's /api/player endpoints. */
class Api(baseUrl: String, private val token: () -> String?) {
    val base = baseUrl.trim().trimEnd('/')

    fun resolve(src: String): String = if (src.startsWith("http://") || src.startsWith("https://")) src else base + src

    fun open(url: String, method: String = "GET", auth: Boolean = true): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            setRequestProperty("Accept", "application/json")
            if (auth) token()?.let { setRequestProperty("Authorization", "Bearer $it") }
        }

    private suspend fun request(path: String, method: String, body: ByteArray?, contentType: String?, auth: Boolean = true): String =
        withContext(Dispatchers.IO) {
            val c = open(base + path, method, auth)
            try {
                if (body != null) {
                    c.doOutput = true
                    c.setRequestProperty("Content-Type", contentType ?: "application/json")
                    c.setFixedLengthStreamingMode(body.size)
                    c.outputStream.use { it.write(body) }
                }
                val code = c.responseCode
                if (code == 401) throw UnauthorizedException()
                val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (code !in 200..299) throw IOException("Portal replied $code: ${text.take(200)}")
                text
            } finally {
                c.disconnect()
            }
        }

    private suspend fun postJson(path: String, json: JSONObject, auth: Boolean = true) =
        JSONObject(request(path, "POST", json.toString().toByteArray(), "application/json", auth))

    suspend fun healthCheck(): Boolean = runCatching {
        JSONObject(request("/healthz", "GET", null, null, auth = false)).optBoolean("ok")
    }.getOrDefault(false)

    suspend fun register(deviceId: String, model: String, appVersion: String): JSONObject =
        postJson("/api/player/register", JSONObject().put("deviceId", deviceId).put("model", model).put("appVersion", appVersion), auth = false)

    suspend fun config(): String = request("/api/player/config", "GET", null, null)

    suspend fun heartbeat(status: JSONObject): JSONObject = postJson("/api/player/heartbeat", status)

    /** Live data (weather, news) for a widget, as the JSON text of "data". */
    suspend fun widgetData(mediaId: Long): String = JSONObject(request("/api/player/widget-data/$mediaId", "GET", null, null)).opt("data").toString()

    suspend fun screenshot(jpeg: ByteArray) {
        request("/api/player/screenshot", "POST", jpeg, "image/jpeg")
    }
}
