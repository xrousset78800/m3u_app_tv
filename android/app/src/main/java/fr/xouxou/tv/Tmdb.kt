package fr.xouxou.tv

import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

// Fiches traduites depuis TMDB (comme lib/tmdb.js) : titres et résumés des films, séries et épisodes.
// Sans clé, sans traduction ou sans réponse, les textes du fournisseur restent affichés.
object Tmdb {
    private const val API = "https://api.themoviedb.org/3"
    private const val IMAGES = "https://image.tmdb.org/t/p/"
    private const val DAY = 24 * 3600 * 1000L
    private val key = BuildConfig.TMDB_KEY.trim()
    private lateinit var languages: Map<String, String> // code de l'interface -> code TMDB

    fun init(languagesJson: String) {
        val list = JSONArray(languagesJson)
        languages = (0 until list.length()).map { list.getJSONObject(it) }.associate { it.getString("code") to (it.optString("tmdb").ifEmpty { it.getString("code") }) }
    }

    val enabled get() = key.isNotEmpty()

    private fun get(route: String, params: Map<String, Any?> = emptyMap()): JSONObject {
        val all = params.filterValues { it != null && it.toString().isNotEmpty() }.toMutableMap()
        val headers = mutableMapOf("accept" to "application/json")
        if (key.length > 40) headers["authorization"] = "Bearer $key" else all["api_key"] = key
        val query = all.entries.joinToString("&") { "${URLEncoder.encode(it.key, "UTF-8")}=${URLEncoder.encode(it.value.toString(), "UTF-8")}" }
        val res = Http.request("$API$route${if (query.isEmpty()) "" else "?$query"}", headers = headers, timeoutMs = 5000)
        if (!res.ok) throw Exception("TMDB ${res.status} sur $route")
        return JSONObject(res.text())
    }

    private fun cached(name: String, maxAge: Long, compute: () -> Any?): Any? {
        val hit = Db.TmdbCache.get(name)
        if (hit != null && System.currentTimeMillis() - hit.second < maxAge) return hit.first.takeIf { it != JSONObject.NULL }
        val value = compute()
        Db.TmdbCache.set(name, value)
        return value
    }

    private var warned = false
    private fun fallback(e: Exception): JSONObject? {
        val refused = e.message?.contains("TMDB 401") == true
        if (!warned || !refused) Log.log("[tmdb] ${e.message} : textes du fournisseur")
        if (refused) warned = true
        return null
    }

    private fun text(o: JSONObject, name: String) = (o.opt(name) as? String)?.trim() ?: ""
    private val PLACEHOLDER = Regex("^(é|e)pisod(e|io)\\s*\\d+$|^folge\\s*\\d+$", RegexOption.IGNORE_CASE)
    private fun genres(o: JSONObject) = o.optJSONArray("genres")?.objects()?.joinToString(", ") { it.optString("name") } ?: ""

    private fun wanted(language: String?) = enabled && language != null && languages.containsKey(language)

    fun movie(tmdbId: String?, language: String?): JSONObject? {
        if (!wanted(language) || !isDigits(tmdbId)) return null
        return try {
            cached("movie:$tmdbId:$language", 30 * DAY) {
                val m = get("/movie/$tmdbId", mapOf("language" to languages[language]))
                jsonOf("name" to text(m, "title"), "plot" to text(m, "overview"), "genre" to genres(m))
            } as? JSONObject
        } catch (e: Exception) {
            fallback(e)
        }
    }

    // « FR - South Park (1997) [MULTI-SUB] » → « South Park ».
    fun cleanName(name: String) = name.trim()
        .replaceFirst(Regex("^[A-Z]{2,4}\\s*[-|:]\\s*"), "")
        .replace(Regex("\\[[^\\]]*\\]|\\(\\d{4}\\)"), "")
        .replaceFirst(Regex("\\s+-\\s+\\d{4}$"), "")
        .trim()

    class Season(val number: Int, val ids: Set<String>)

    private fun findSeries(providerId: String, name: String, year: String?, sample: Season): Long? =
        (cached("series-match:$providerId", 30 * DAY) {
            val query = cleanName(name)
            if (query.isEmpty()) return@cached null
            var results = get("/search/tv", mapOf("query" to query, "first_air_date_year" to year)).optJSONArray("results")?.objects() ?: emptyList()
            if (results.isEmpty() && !year.isNullOrEmpty()) results = get("/search/tv", mapOf("query" to query)).optJSONArray("results")?.objects() ?: emptyList()
            for (candidate in results.take(3)) {
                val id = candidate.getLong("id")
                val show = get("/tv/$id", mapOf("append_to_response" to "season/${sample.number}"))
                val episodes = show.optJSONObject("season/${sample.number}")?.optJSONArray("episodes")?.objects() ?: emptyList()
                if (episodes.any { sample.ids.contains(it.opt("id").toString()) }) return@cached id
            }
            null
        } as? Number)?.toLong()

    fun series(providerId: String, name: String, year: String?, seasons: List<Season>, language: String?): JSONObject? {
        if (!wanted(language)) return null
        val sample = seasons.find { it.ids.isNotEmpty() } ?: return null
        return try {
            val tmdbId = findSeries(providerId, name, year, sample) ?: return null
            cached("series:$tmdbId:$language:${seasons.joinToString(",") { it.number.toString() }}", 7 * DAY) {
                val numbers = seasons.map { it.number }
                var show: JSONObject? = null
                val episodes = JSONObject()
                for (chunk in numbers.chunked(20)) {
                    val part = get("/tv/$tmdbId", mapOf("language" to languages[language], "append_to_response" to chunk.joinToString(",") { "season/$it" }))
                    if (show == null) show = part
                    for (n in chunk) {
                        for (e in part.optJSONObject("season/$n")?.optJSONArray("episodes")?.objects() ?: emptyList()) {
                            val title = text(e, "name")
                            val still = e.opt("still_path") as? String
                            episodes.put(e.opt("id").toString(), jsonOf(
                                "title" to if (PLACEHOLDER.matches(title)) "" else title,
                                "plot" to text(e, "overview"),
                                "image" to if (!still.isNullOrEmpty()) "${IMAGES}w300$still" else "",
                            ))
                        }
                    }
                }
                val s = show ?: JSONObject()
                jsonOf("name" to text(s, "name"), "plot" to text(s, "overview"), "genre" to genres(s), "episodes" to episodes)
            } as? JSONObject
        } catch (e: Exception) {
            fallback(e)
        }
    }
}

// Sous-titres d'OpenSubtitles (comme lib/opensubtitles.js) : chaque téléchargement compte, on les garde en base.
object OpenSubtitles {
    private const val API = "https://api.opensubtitles.com/api/v1"
    private const val SEARCH_CACHE = 3600 * 1000L
    private val key = BuildConfig.OPENSUBTITLES_KEY.trim()
    val enabled get() = key.isNotEmpty()

    private fun call(route: String, params: Map<String, Any?>? = null, body: JSONObject? = null, retried: Boolean = false): JSONObject {
        // Paramètres triés et en minuscules : sinon l'API répond par une redirection.
        val query = params?.keys?.sorted()?.joinToString("&") { "${URLEncoder.encode(it, "UTF-8")}=${URLEncoder.encode(params[it].toString().lowercase(), "UTF-8")}" }
        val headers = mutableMapOf("Api-Key" to key, "User-Agent" to "TV v${BuildConfig.VERSION_NAME}", "Accept" to "application/json")
        if (body != null) headers["Content-Type"] = "application/json"
        val res = try {
            Http.request("$API$route${if (query.isNullOrEmpty()) "" else "?$query"}", if (body != null) "POST" else "GET", headers, body?.toString()?.toByteArray(), 10000)
        } catch (e: Exception) {
            throw fail(502, "subtitlesUnreachable")
        }
        if (res.status == 429 && !retried) {
            Thread.sleep(1500)
            return call(route, params, body, true)
        }
        val data = runCatching { JSONObject(res.text()) }.getOrElse { JSONObject() }
        if (res.status == 406 || (route == "/download" && res.ok && data.optString("link").isEmpty())) {
            val reset = runCatching {
                java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.ROOT).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
                    .parse(data.optString("reset_time_utc"))
            }.getOrNull()
            val time = reset?.let { java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(it) } ?: "?"
            throw fail(429, "subtitlesQuota", mapOf("time" to time))
        }
        if (res.status == 401 || res.status == 403) throw fail(502, "subtitlesKey")
        if (!res.ok) {
            Log.log("[opensubtitles] HTTP ${res.status} sur $route")
            throw fail(502, "subtitlesUnreachable")
        }
        return data
    }

    private val searches = HashMap<String, Pair<Long, JSONObject>>()

    fun search(tmdbId: String?, title: String?, season: Any?, episode: Any?, languages: String, fps: Double?): JSONArray {
        if (!enabled) throw fail(503, "subtitlesKey")
        val params = linkedMapOf<String, Any?>("languages" to languages)
        if (!tmdbId.isNullOrEmpty()) params["tmdb_id"] = tmdbId
        else {
            params["query"] = title
            if (season != null && episode != null) {
                params["type"] = "episode"
                params["season_number"] = season
                params["episode_number"] = episode
            }
        }
        val name = params.toSortedMap().toString()
        val hit = synchronized(searches) { searches[name] }
        val data = if (hit != null && System.currentTimeMillis() - hit.first < SEARCH_CACHE) hit.second else call("/subtitles", params)
        synchronized(searches) { searches[name] = System.currentTimeMillis() to data }

        class Found(val o: JSONObject, val speed: Int, val automatic: Boolean, val foreign: Boolean, val downloads: Long)
        val found = (data.optJSONArray("data")?.objects() ?: emptyList()).mapNotNull { item ->
            val a = item.optJSONObject("attributes") ?: return@mapNotNull null
            val files = a.optJSONArray("files")?.objects() ?: emptyList()
            val fileId = files.firstOrNull()?.opt("file_id")?.toString()?.takeIf { it.isNotEmpty() && it != "null" && it != "0" } ?: return@mapNotNull null
            if (files.size != 1) return@mapNotNull null
            val sFps = a.optDouble("fps", 0.0).takeIf { it != 0.0 && !it.isNaN() }
            val speed = if (fps == null || sFps == null) 1 else if (Math.abs(sFps - fps) < 0.01) 0 else 2
            val automatic = a.optBoolean("ai_translated") || a.optBoolean("machine_translated")
            val foreign = a.optBoolean("foreign_parts_only")
            val downloads = a.optLong("download_count")
            Found(jsonOf(
                "fileId" to fileId,
                "language" to a.optString("language"),
                "release" to a.optString("release").ifEmpty { files.first().optString("file_name") },
                "fps" to sFps, "speed" to speed, "downloads" to downloads,
                "hearingImpaired" to a.optBoolean("hearing_impaired"), "foreignOnly" to foreign, "automatic" to automatic, "parts" to files.size,
            ), speed, automatic, foreign, downloads)
        }
        return JSONArray(found.sortedWith(compareBy<Found>({ it.speed }, { it.automatic }, { it.foreign }, { -it.downloads })).take(40).map { it.o })
    }

    private fun decode(bytes: ByteArray): String = try {
        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    } catch (e: Exception) {
        String(bytes, charset("windows-1252"))
    }

    fun download(fileId: String): Pair<JSONArray, Any?> {
        if (!enabled) throw fail(503, "subtitlesKey")
        val data = call("/download", body = jsonOf("file_id" to fileId.toLongOrNull(), "sub_format" to "webvtt"))
        val res = runCatching { Http.request(data.getString("link"), timeoutMs = 10000) }.getOrNull()
        if (res == null || !res.ok) throw fail(502, "subtitlesUnreachable")
        val cues = Vtt.parse(decode(res.body))
        if (cues.length() == 0) throw fail(502, "subtitlesEmpty")
        val remaining = data.opt("remaining").takeIf { it is Number }
        return cues to remaining
    }
}

object Vtt {
    private fun time(text: String) = text.split(":").fold(0.0) { sum, part -> sum * 60 + (part.toDoubleOrNull() ?: Double.NaN) }

    fun cue(block: String): JSONObject? {
        val lines = block.split(Regex("\\r?\\n"))
        val at = lines.indexOfFirst { it.contains("-->") }
        if (at < 0) return null
        val parts = lines[at].split("-->").map { time(it.trim().split(Regex("\\s"))[0]) }
        if (parts.size < 2) return null
        val text = lines.drop(at + 1).joinToString("\n").trim()
        return if (text.isNotEmpty() && parts[0].isFinite() && parts[1].isFinite()) jsonOf("start" to parts[0], "end" to parts[1], "text" to text) else null
    }

    fun parse(text: String) = JSONArray(text.split(Regex("\\r?\\n\\r?\\n")).mapNotNull { cue(it) })
}
