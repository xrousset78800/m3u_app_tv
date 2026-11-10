package fr.xouxou.tv

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.Normalizer

// Erreur prévue : `key` et `vars` donnent le message traduit par l'interface (en-tête X-Error, clés « error.* »).
class ApiError(val status: Int, message: String, val key: String? = null, val vars: Map<String, Any?>? = null) : Exception(message)

fun fail(status: Int, key: String, vars: Map<String, Any?>? = null) = ApiError(status, key, key, vars)

// Comme normalize() de db.js : sans accents, en minuscules.
private val MARKS = Regex("\\p{Mn}+")
fun normalize(text: String): String = MARKS.replace(Normalizer.normalize(text, Normalizer.Form.NFD), "").lowercase()

fun isDigits(text: String?) = !text.isNullOrEmpty() && text.all { it in '0'..'9' }

fun jsonOf(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) o.put(k, v ?: JSONObject.NULL)
    return o
}

fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

// Champ texte d'une réponse JSON du fournisseur : chaîne, nombre, ou rien.
fun JSONObject.text(name: String): String {
    if (!has(name) || isNull(name)) return ""
    return when (val v = opt(name)) {
        is String -> v
        is Number, is Boolean -> v.toString()
        else -> ""
    }
}

// Accès HTTP sortants : redirections suivies à la main (même d'http vers https), délais bornés.
object Http {
    class Response(val status: Int, val url: String, val type: String, val body: ByteArray) {
        val ok get() = status in 200..299
        fun text() = String(body, Charsets.UTF_8)
    }

    fun open(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        timeoutMs: Int = 20000,
    ): HttpURLConnection {
        var current = url
        repeat(8) {
            val c = URL(current).openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = timeoutMs
            c.readTimeout = timeoutMs
            c.requestMethod = method
            for ((k, v) in headers) c.setRequestProperty(k, v)
            if (body != null) {
                c.doOutput = true
                c.outputStream.use { it.write(body) }
            }
            val status = c.responseCode
            if (status in 300..399 && status != 304) {
                val location = c.getHeaderField("Location")
                if (location != null) {
                    current = URL(URL(current), location).toString()
                    c.disconnect()
                    return@repeat
                }
            }
            return c
        }
        throw java.io.IOException("Trop de redirections")
    }

    fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        timeoutMs: Int = 20000,
    ): Response {
        val c = open(url, method, headers, body, timeoutMs)
        try {
            val stream = if (c.responseCode >= 400) c.errorStream else c.inputStream
            return Response(c.responseCode, c.url.toString(), c.contentType ?: "", stream?.use { readAll(it) } ?: ByteArray(0))
        } finally {
            c.disconnect()
        }
    }

    fun readAll(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        input.copyTo(out)
        return out.toByteArray()
    }
}

// encodeURIComponent de JavaScript (pour l'en-tête X-Error).
fun encodeUriComponent(text: String): String =
    java.net.URLEncoder.encode(text, "UTF-8").replace("+", "%20").replace("%21", "!").replace("%27", "'")
        .replace("%28", "(").replace("%29", ")").replace("%7E", "~")
