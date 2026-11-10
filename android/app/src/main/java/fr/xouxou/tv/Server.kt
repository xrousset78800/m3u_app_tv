package fr.xouxou.tv

import android.content.res.AssetManager
import android.util.Base64
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

// Le serveur de l'appli Windows (server.js), sur 127.0.0.1 : la page d'interface est la même.
// Les flux ne passent pas par lui : le lecteur natif (Player) les lit directement chez le fournisseur.
class Server(private val assets: AssetManager, languagesJson: String) : NanoHTTPD("127.0.0.1", 0) {
    // Clé posée en cookie dans la WebView : les autres applis de l'appareil ne peuvent pas appeler l'API.
    val key: String = ByteArray(24).also { SecureRandom().nextBytes(it) }.hex()
    private val languageNames = JSONArray(languagesJson).objects().let { list ->
        JSONObject().apply { for (l in list) put(l.getString("code"), l.getString("name")) }
    }

    private class Params(private val map: Map<String, List<String>>) {
        fun get(name: String): String? = map[name]?.firstOrNull()
        fun has(name: String) = map.containsKey(name)
        fun int(name: String) = get(name)?.trim()?.toDoubleOrNull()?.toInt()?.coerceAtLeast(0) ?: 0
        fun num(name: String) = get(name)?.trim()?.toDoubleOrNull()?.takeIf { it.isFinite() }
    }

    private class Request(val session: IHTTPSession, val params: Params, val match: MatchResult, val profile: Profiles.Current?) {
        var cookie: String? = null
        val body: String by lazy { readBody(session, 20_000_000) }
        fun json(limit: Int = 200_000): JSONObject {
            if (body.length > limit) throw ApiError(413, "Requête trop volumineuse")
            return runCatching { JSONTokener(body).nextValue() as JSONObject }.getOrElse { throw ApiError(400, "JSON invalide") }
        }
        val user get() = profile!!
    }

    private class Route(val method: Method, val pattern: Regex, val access: String, val handler: (Request) -> Any?)

    private class Text(val status: Int, val text: String, val error: ApiError? = null)

    // --- Fiches ---

    private fun overlay(base: JSONObject, extra: JSONObject?): JSONObject {
        if (extra != null) for (k in extra.keys()) (extra.opt(k) as? String)?.takeIf { it.isNotEmpty() }?.let { base.put(k, it) }
        return base
    }

    private fun first(vararg values: String) = values.firstOrNull { it.isNotEmpty() } ?: ""

    private fun vodInfo(id: String, language: String?): JSONObject {
        val all = Xtream.apiObject("get_vod_info", mapOf("vod_id" to id))
        val info = all.optJSONObject("info") ?: JSONObject()
        val data = all.optJSONObject("movie_data") ?: JSONObject()
        val tmdbId = info.text("tmdb_id").takeIf { isDigits(it) } ?: ""
        return overlay(jsonOf(
            "id" to id,
            "name" to first(data.text("name"), info.text("name")),
            "ext" to data.text("container_extension").ifEmpty { null },
            "cover" to first(info.text("cover_big"), info.text("movie_image")),
            "plot" to first(info.text("plot"), info.text("description")),
            "genre" to info.text("genre"),
            "year" to info.text("releasedate").take(4),
            "duration" to info.text("duration"),
            "rating" to info.text("rating").toDoubleOrNull()?.takeIf { it != 0.0 },
            "director" to info.text("director"),
            "cast" to first(info.text("cast"), info.text("actors")),
            "tmdbId" to tmdbId,
        ), Tmdb.movie(tmdbId, language))
    }

    // Saisons du fournisseur : objet { "1": [...] } ou, chez certains, liste de listes.
    private fun seasonLists(episodes: Any?): List<Pair<Int, List<JSONObject>>> = when (episodes) {
        is JSONObject -> episodes.keys().asSequence().map { (it.toDoubleOrNull()?.toInt() ?: 0) to (episodes.optJSONArray(it)?.objects() ?: emptyList()) }.toList()
        is JSONArray -> (0 until episodes.length()).mapNotNull { episodes.optJSONArray(it)?.objects() }
            .map { list -> (list.firstOrNull()?.text("season")?.toIntOrNull() ?: 0) to list }
        else -> emptyList()
    }

    private fun seriesInfo(id: String, language: String?): JSONObject {
        val all = Xtream.apiObject("get_series_info", mapOf("series_id" to id))
        val info = all.optJSONObject("info") ?: JSONObject()
        val seasons = seasonLists(all.opt("episodes")).sortedBy { it.first }.map { (number, list) ->
            number to list.map { e ->
                val ei = e.optJSONObject("info") ?: JSONObject()
                jsonOf(
                    "id" to e.opt("id"),
                    "num" to (e.text("episode_num").toDoubleOrNull() ?: 0.0).let { if (it == Math.floor(it)) it.toLong() else it },
                    "title" to e.opt("title"),
                    "ext" to e.opt("container_extension"),
                    "plot" to ei.text("plot"),
                    "image" to ei.text("movie_image"),
                    "duration" to ei.text("duration"),
                    "tmdbId" to ei.text("tmdb_id").let { if (it == "0" && ei.opt("tmdb_id") !is String) "" else it },
                )
            }
        }
        val result = jsonOf(
            "id" to id,
            "name" to info.opt("name"),
            "cover" to info.opt("cover"),
            "plot" to info.text("plot"),
            "genre" to info.text("genre"),
            "year" to info.text("releaseDate").take(4),
            "rating" to info.text("rating").toDoubleOrNull()?.takeIf { it != 0.0 },
            "cast" to info.text("cast"),
            "seasons" to JSONArray(seasons.map { (n, list) -> jsonOf("number" to n, "episodes" to JSONArray(list)) }),
        )
        val translated = Tmdb.series(
            id, result.optString("name"), result.optString("year").ifEmpty { null },
            seasons.map { (n, list) -> Tmdb.Season(n, list.map { it.optString("tmdbId") }.filter { it.isNotEmpty() }.toSet()) },
            language,
        )
        if (translated != null) {
            val episodes = translated.optJSONObject("episodes") ?: JSONObject()
            translated.remove("episodes")
            overlay(result, translated)
            // Image du fournisseur d'abord : TMDB ne sert qu'à combler un manque.
            for ((_, list) in seasons) for (e in list) {
                val found = episodes.optJSONObject(e.optString("tmdbId")) ?: continue
                overlay(e, jsonOf("title" to found.optString("title"), "plot" to found.optString("plot"),
                    "image" to if (e.optString("image").isNotEmpty()) "" else found.optString("image")))
            }
        }
        return result
    }

    private fun decode64(text: String) = runCatching { String(Base64.decode(text, Base64.DEFAULT), Charsets.UTF_8) }.getOrDefault("")

    // "2026-10-21 17:30:00" (heure du serveur) -> "2026-10-21:17-30", format attendu par /timeshift
    private fun replayStart(start: String): String {
        val parts = start.split(" ")
        return "${parts[0]}:${parts.getOrElse(1) { "" }.take(5).replace(":", "-")}"
    }

    private val epgCache = ConcurrentHashMap<String, Pair<Long, JSONArray>>()

    private fun epg(id: String): JSONArray {
        epgCache[id]?.let { if (System.currentTimeMillis() - it.first < 10 * 60 * 1000) return it.second }
        val listings = runCatching { Xtream.apiObject("get_simple_data_table", mapOf("stream_id" to id)).optJSONArray("epg_listings")?.objects() }
            .getOrNull() ?: emptyList()
        val data = if (listings.isNotEmpty()) JSONArray(listings.map { e ->
            jsonOf(
                "title" to decode64(e.text("title")),
                "description" to decode64(e.text("description")),
                "start" to (e.text("start_timestamp").toLongOrNull() ?: 0L),
                "end" to (e.text("stop_timestamp").toLongOrNull() ?: 0L),
                "replayStart" to replayStart(e.text("start")),
                "archive" to ((e.text("has_archive").toDoubleOrNull() ?: 0.0) != 0.0),
            )
        }.sortedBy { it.getLong("start") }) else Db.channelProgrammes(id)
        epgCache[id] = System.currentTimeMillis() to data
        return data
    }

    // --- Sous-titres en ligne ---

    private val MEDIA_KINDS = listOf("movie", "series")
    private val TYPES = listOf("live", "vod", "series")

    private fun mediaKey(kind: String?, id: String?): String {
        if (kind !in MEDIA_KINDS || !isDigits(id)) throw ApiError(400, "Paramètres invalides")
        return "$kind:$id"
    }

    private val LANGUAGES = Regex("^[a-z]{2}(-[a-z]{2})?(,[a-z]{2}(-[a-z]{2})?)*$")
    private val NUMBER = Regex("^\\d{1,4}$")

    private fun searchSubtitles(p: Params): JSONArray {
        mediaKey(p.get("kind"), p.get("id"))
        val languages = p.get("languages") ?: ""
        if (!LANGUAGES.matches(languages)) throw ApiError(400, "Langue invalide")
        var tmdbId = p.get("tmdb")?.takeIf { isDigits(it) } ?: ""
        // Film lancé sans sa fiche (playlist) : l'identifiant TMDB est chez le fournisseur.
        if (tmdbId.isEmpty() && p.get("kind") == "movie") {
            val info = runCatching { Xtream.apiObject("get_vod_info", mapOf("vod_id" to p.get("id")!!)).optJSONObject("info") }.getOrNull()
            info?.text("tmdb_id")?.takeIf { isDigits(it) }?.let { tmdbId = it }
        }
        val title = Tmdb.cleanName(p.get("title") ?: "").replace(Regex("\\s+—\\s+S\\d+E\\d+$"), "")
        if (tmdbId.isEmpty() && title.isEmpty()) return JSONArray()
        // Épisode sans identifiant TMDB : titre de la série, avec sa saison et son numéro.
        fun number(name: String) = p.get(name)?.takeIf { NUMBER.matches(it) }?.toInt()
        val episode = p.get("kind") == "series" && number("season") != null && number("episode") != null
        return OpenSubtitles.search(tmdbId, title, if (episode) number("season") else null, if (episode) number("episode") else null,
            languages, p.num("fps")?.takeIf { it != 0.0 })
    }

    private fun downloadSubtitle(input: JSONObject): JSONObject {
        val media = mediaKey(input.text("kind").ifEmpty { null }, input.text("id"))
        val fileId = input.text("fileId")
        if (!isDigits(fileId)) throw ApiError(400, "Paramètres invalides")
        val language = input.text("language").take(10)
        val release = input.text("release").take(300)
        var cues = Db.SavedSubtitles.cues(media, fileId)
        var remaining: Any? = null
        if (cues == null) {
            cues = Db.SavedSubtitles.anyCues(fileId)
            if (cues == null) OpenSubtitles.download(fileId).let { cues = it.first; remaining = it.second }
            Db.SavedSubtitles.save(media, fileId, language, release, cues!!)
        }
        return jsonOf("fileId" to fileId, "language" to language, "release" to release, "cues" to cues, "remaining" to remaining)
    }

    // --- Comptes : ce qu'un compte restreint peut voir ---

    private fun groupsFor(p: Profiles.Current, type: String) = p.groups // Db.Groups[type] rend [] pour un type absent

    private fun notAllowed() = ApiError(403, "Non autorisé", "notAllowed")

    private fun allow(p: Profiles.Current, type: String, id: String) {
        if (p.groups != null && !Db.itemAllowed(type, id, p.groups)) throw notAllowed()
    }

    private fun allowMedia(p: Profiles.Current, params: Params) {
        if (p.groups == null) return
        val id = params.get("id") ?: ""
        if (params.get("kind") == "movie") return allow(p, "vod", id)
        val episodes = p.session.episodes
        if (episodes.contains(id)) return
        val series = params.get("series") ?: ""
        if (isDigits(series)) {
            allow(p, "series", series)
            for ((_, list) in seasonLists(Xtream.apiObject("get_series_info", mapOf("series_id" to series)).opt("episodes")))
                for (e in list) episodes.add(e.text("id"))
        }
        if (!episodes.contains(id)) throw notAllowed()
    }

    private fun idsParam(p: Params) = if (p.has("ids")) (p.get("ids") ?: "").split(",").filter { isDigits(it) } else null

    private val EXT = Regex("^[a-z0-9]{2,4}$", RegexOption.IGNORE_CASE)

    // Film ou épisode : un seul lecteur préparé par fichier, quel que soit le point de départ.
    private fun mediaSource(p: Params, start: Double = 0.0, audio: Int = 0): Source {
        val kind = p.get("kind") ?: ""
        val id = p.get("id") ?: ""
        val ext = p.get("ext") ?: ""
        if (kind !in MEDIA_KINDS || !isDigits(id) || !EXT.matches(ext)) throw ApiError(400, "Paramètres invalides")
        return Source("media:$kind:$id:$ext", Xtream.mediaUrl(kind, id, ext), hls = false, start = start, audio = audio, media = true)
    }

    private val REPLAY_START = Regex("^\\d{4}-\\d{2}-\\d{2}:\\d{2}-\\d{2}$")

    // Adresse donnée au <video> par la page -> flux du fournisseur, avec les mêmes contrôles d'accès que server.js.
    fun resolve(src: String, cookie: String?): Source {
        val profile = Profiles.fromCookie(cookie) ?: throw ApiError(401, "Aucun compte choisi", "noProfile")
        val uri = android.net.Uri.parse(if (src.startsWith("http")) src else "http://localhost$src")
        val p = Params(uri.queryParameterNames.associateWith { listOfNotNull(uri.getQueryParameter(it)) })
        val path = uri.path ?: ""
        Regex("^/media/stream$").find(path)?.let {
            allowMedia(profile, p)
            return mediaSource(p, p.num("start")?.coerceAtLeast(0.0) ?: 0.0, p.int("audio"))
        }
        Regex("^/live/(\\d+)\\.m3u8$").find(path)?.let {
            val id = it.groupValues[1]
            allow(profile, "live", id)
            return Source("live:$id", Xtream.liveUrl(id), hls = true, fallback = Xtream.liveRawUrl(id), live = true)
        }
        Regex("^/media/live/(\\d+)$").find(path)?.let {
            val id = it.groupValues[1]
            allow(profile, "live", id)
            return Source("raw:$id", Xtream.liveRawUrl(id), hls = false, live = true)
        }
        Regex("^/replay/(\\d+)\\.m3u8$").find(path)?.let {
            val id = it.groupValues[1]
            allow(profile, "live", id)
            val start = p.get("start") ?: ""
            val minutes = p.get("minutes")?.toIntOrNull() ?: 0
            if (!REPLAY_START.matches(start) || minutes <= 0) throw ApiError(400, "Paramètres invalides")
            return Source("replay:$id:$start", Xtream.replayUrl(id, start, minutes), hls = true)
        }
        throw ApiError(404, "Introuvable")
    }

    // --- Routes (accès : 'public' sans compte choisi, 'admin' pour l'administrateur ; sinon tout compte) ---

    private fun ok() = jsonOf("ok" to true)
    private fun type(r: Request) = r.params.get("type")?.takeIf { it in TYPES }

    private val routes = listOf(
        Route(Method.GET, Regex("^/api/profiles$"), "public") { r ->
            val profile = r.profile
            var current: JSONObject? = profile?.let { jsonOf("id" to it.id, "name" to it.name, "role" to it.role, "locked" to it.locked, "groups" to it.groups?.toJson()) }
            val automatic = if (profile == null) Profiles.automatic() else null
            if (automatic != null) {
                r.cookie = Profiles.open(automatic)
                current = jsonOf("id" to automatic.id, "name" to automatic.name, "role" to automatic.role, "locked" to false, "groups" to automatic.groups?.toJson())
            }
            jsonOf("current" to current, "profiles" to Profiles.list())
        },
        Route(Method.POST, Regex("^/api/profiles/select$"), "public") { r ->
            val input = r.json()
            r.cookie = Profiles.select((input.opt("id") as? Number)?.toLong(), input.opt("password") as? String)
            ok()
        },
        Route(Method.POST, Regex("^/api/profiles/leave$"), "public") { r ->
            r.cookie = Profiles.close(r.session.headers["cookie"])
            ok()
        },
        Route(Method.POST, Regex("^/api/profiles$"), "admin") { r -> jsonOf("id" to Profiles.create(r.json())) },
        Route(Method.PUT, Regex("^/api/profiles/(\\d+)$"), "admin") { r ->
            Profiles.update(r.match.groupValues[1].toLongOrNull(), r.json())
            ok()
        },
        Route(Method.DELETE, Regex("^/api/profiles/(\\d+)$"), "admin") { r ->
            Profiles.remove(r.match.groupValues[1].toLongOrNull(), r.user.id)
            ok()
        },
        Route(Method.GET, Regex("^/api/status$"), "") { r ->
            val status = Db.status().put("tmdb", Tmdb.enabled).put("opensubtitles", OpenSubtitles.enabled).put("languages", languageNames)
            if (r.user.role != "admin") status.remove("account")
            status
        },
        Route(Method.POST, Regex("^/api/login$"), "admin") { r ->
            Xtream.login(r.json())
            Xtream.readConfig()?.let { Log.secret(java.net.URL(it.server).host) }
            Db.status()
        },
        // Avancement de l'import en cours (null s'il n'y en a pas).
        Route(Method.GET, Regex("^/api/sync$"), "admin") { _ -> jsonOf("progress" to Db.syncProgress()) },
        Route(Method.POST, Regex("^/api/sync$"), "admin") { _ ->
            Db.sync()
            Db.status()
        },
        Route(Method.POST, Regex("^/api/logout$"), "admin") { _ ->
            Player.onMain { Player.stop() }
            Db.reset()
            Xtream.forgetConfig()
            epgCache.clear()
            Db.status()
        },
        Route(Method.GET, Regex("^/api/categories$"), "") { r ->
            val type = type(r) ?: return@Route Text(400, "Type inconnu")
            Db.categories(type, groupsFor(r.user, type))
        },
        Route(Method.GET, Regex("^/api/list$"), "") { r ->
            val type = type(r) ?: return@Route Text(400, "Type inconnu")
            JSONArray(Db.list(type, r.params.get("category"), idsParam(r.params), r.params.get("q"), r.params.int("offset"),
                groups = groupsFor(r.user, type), sort = r.params.get("sort")))
        },
        Route(Method.GET, Regex("^/api/versions$"), "") { r ->
            val type = type(r) ?: return@Route Text(400, "Type inconnu")
            val id = r.params.get("id") ?: ""
            allow(r.user, type, id)
            Db.versions(type, id, if (r.params.has("q")) r.params.get("q") ?: "" else null, groupsFor(r.user, type)) ?: Text(404, "Introuvable")
        },
        Route(Method.GET, Regex("^/api/manage/categories$"), "admin") { r ->
            val type = type(r) ?: return@Route Text(400, "Type inconnu")
            Db.manageCategories(type)
        },
        Route(Method.GET, Regex("^/api/manage/items$"), "admin") { r ->
            val type = type(r) ?: return@Route Text(400, "Type inconnu")
            JSONArray(Db.list(type, r.params.get("category"), null, r.params.get("q"), r.params.int("offset"), includeHidden = true))
        },
        Route(Method.POST, Regex("^/api/hidden$"), "admin") { r ->
            val input = r.json()
            val type = input.opt("type") as? String
            val kind = input.opt("kind") as? String
            val ids = input.opt("ids") as? JSONArray
            if (type !in TYPES || kind !in listOf("category", "item") || ids == null || (0 until ids.length()).any { ids.opt(it) !is String }) {
                return@Route Text(400, "Paramètres invalides")
            }
            Db.setHidden(type!!, kind!!, (0 until ids.length()).map { ids.getString(it) }, truthy(input.opt("hidden")))
            ok()
        },
        Route(Method.GET, Regex("^/api/backup$"), "admin") { _ -> Db.backup() },
        Route(Method.POST, Regex("^/api/restore$"), "admin") { r ->
            val input = r.json(20_000_000)
            val hidden = input.optJSONArray("hidden")
            val list = hidden?.let { h -> (0 until h.length()).map { h.opt(it) as? JSONObject } }
            val valid = list != null && list.all { h -> h != null && h.opt("type") in TYPES && h.opt("kind") in listOf("category", "item") && h.opt("id") is String }
            if (!valid) return@Route Text(400, "Sauvegarde invalide", fail(400, "badBackup"))
            Db.restore(Profiles.restore(input.opt("profiles")), list!!.map { Triple(it!!.getString("type"), it.getString("kind"), it.getString("id")) })
            r.cookie = Profiles.close(r.session.headers["cookie"])
            ok()
        },
        Route(Method.GET, Regex("^/api/guide$"), "") { r ->
            val at = r.params.num("at")?.toLong()?.takeIf { it != 0L } ?: (System.currentTimeMillis() / 1000)
            Db.guide(r.params.get("category"), idsParam(r.params), r.params.get("q"), r.params.int("offset"), at,
                r.params.num("evening")?.toLong()?.takeIf { it != 0L }, 2, groupsFor(r.user, "live"))
        },
        Route(Method.GET, Regex("^/api/programmes$"), "") { r ->
            val at = r.params.num("at")?.toLong()?.takeIf { it != 0L } ?: (System.currentTimeMillis() / 1000)
            Db.searchProgrammes(r.params.get("q"), at, groupsFor(r.user, "live"))
        },
        Route(Method.GET, Regex("^/api/vod/(\\d+)$"), "") { r ->
            allow(r.user, "vod", r.match.groupValues[1])
            vodInfo(r.match.groupValues[1], r.params.get("language"))
        },
        Route(Method.GET, Regex("^/api/series/(\\d+)$"), "") { r ->
            allow(r.user, "series", r.match.groupValues[1])
            val info = seriesInfo(r.match.groupValues[1], r.params.get("language"))
            for (season in info.getJSONArray("seasons").objects()) for (e in season.getJSONArray("episodes").objects()) r.user.session.episodes.add(e.text("id"))
            info
        },
        Route(Method.GET, Regex("^/api/epg/(\\d+)$"), "") { r ->
            allow(r.user, "live", r.match.groupValues[1])
            epg(r.match.groupValues[1])
        },
        Route(Method.GET, Regex("^/api/media/probe$"), "") { r ->
            allowMedia(r.user, r.params)
            Player.probe(mediaSource(r.params))
        },
        // Le lecteur natif se place au point exact demandé : pas d'image clé à chercher comme ffmpeg.
        Route(Method.GET, Regex("^/api/media/seek$"), "") { r ->
            allowMedia(r.user, r.params)
            mediaSource(r.params)
            Player.onMain { Player.keep() }
            jsonOf("start" to (r.params.num("start") ?: 0.0).coerceAtLeast(0.0))
        },
        Route(Method.GET, Regex("^/api/media/subtitles$"), "") { r ->
            allowMedia(r.user, r.params)
            Player.subtitles(mediaSource(r.params, (r.params.num("start") ?: 0.0).coerceAtLeast(0.0)), r.params.int("track"), r.params.int("from"))
        },
        Route(Method.GET, Regex("^/api/subtitles/saved$"), "") { r -> Db.SavedSubtitles.list(mediaKey(r.params.get("kind"), r.params.get("id"))) },
        Route(Method.GET, Regex("^/api/subtitles/cues$"), "") { r ->
            Db.SavedSubtitles.cues(mediaKey(r.params.get("kind"), r.params.get("id")), r.params.get("file") ?: "") ?: Text(404, "Introuvable")
        },
        Route(Method.GET, Regex("^/api/subtitles/search$"), "") { r -> searchSubtitles(r.params) },
        Route(Method.POST, Regex("^/api/subtitles/download$"), "") { r -> downloadSubtitle(r.json()) },
        // Ce que le lecteur a vécu (attentes, erreurs, flux coupé), pour le journal.
        Route(Method.POST, Regex("^/api/log$"), "") { r ->
            val text = r.json(2000).opt("text") as? String
            if (!text.isNullOrEmpty()) Log.log("[lecteur] ${text.replace(Regex("\\s+"), " ").take(300)}")
            ok()
        },
        // hls.js n'est pas chargé : la page passe par le <video> « natif » (voir tv.js).
        Route(Method.GET, Regex("^/vendor/hls\\.min\\.js$"), "public") { _ -> Static("text/javascript", ByteArray(0)) },
    )

    private fun truthy(v: Any?) = when (v) {
        null, JSONObject.NULL, false -> false
        is Number -> v.toDouble() != 0.0 && !v.toDouble().isNaN()
        is String -> v.isNotEmpty()
        else -> true
    }

    private class Static(val mime: String, val data: ByteArray)

    // --- HTTP ---

    private fun status(code: Int) = Response.Status.lookup(code) ?: object : Response.IStatus {
        override fun getDescription() = "$code Error"
        override fun getRequestStatus() = code
    }

    private fun text(status: Int, text: String, error: ApiError? = null): Response {
        val res = newFixedLengthResponse(status(status), "text/plain; charset=utf-8", text)
        if (error?.key != null) {
            val payload = jsonOf("key" to error.key, "vars" to error.vars?.let { JSONObject(it) })
            res.addHeader("X-Error", encodeUriComponent(payload.toString()))
        }
        return res
    }

    private val MIME = mapOf(
        "html" to "text/html; charset=utf-8", "js" to "text/javascript", "css" to "text/css", "svg" to "image/svg+xml",
        "json" to "application/json; charset=utf-8", "png" to "image/png", "jpg" to "image/jpeg", "webp" to "image/webp",
        "ico" to "image/x-icon", "woff2" to "font/woff2", "woff" to "font/woff",
    )

    private fun asset(path: String) = try {
        assets.open(path).use { Http.readAll(it) }
    } catch (e: FileNotFoundException) {
        null
    }

    private var indexHtml: ByteArray? = null

    // La page de l'appli Windows, plus ce qui l'adapte à la télé (tv.css, tv.js avant app.js).
    private fun index(): ByteArray = indexHtml ?: run {
        var html = String(asset("public/index.html") ?: ByteArray(0), Charsets.UTF_8)
        html = html.replace(Regex("<meta name=\"viewport\"[^>]*>"), "<meta name=\"viewport\" content=\"width=1440\">")
        html = html.replace("</head>", "<link rel=\"stylesheet\" href=\"/tv/tv.css\">\n</head>")
        val app = Regex("<script[^>]*src=\"/?app\\.js\"[^>]*></script>").find(html)
        html = if (app != null) html.replaceRange(app.range, "<script src=\"/tv/tv.js\"></script>\n${app.value}")
        else html.replace("</body>", "<script src=\"/tv/tv.js\"></script>\n</body>")
        html.toByteArray().also { indexHtml = it }
    }

    private fun serveStatic(pathname: String): Response {
        val clean = pathname.trimStart('/').ifEmpty { "index.html" }
        if (clean.split('/').any { it == ".." }) return text(403, "Interdit")
        val data = when {
            clean == "index.html" -> index()
            clean.startsWith("tv/") -> asset(clean)
            else -> asset("public/$clean")
        } ?: return text(404, "Introuvable")
        val res = newFixedLengthResponse(Response.Status.OK, MIME[clean.substringAfterLast('.', "")] ?: "application/octet-stream", ByteArrayInputStream(data), data.size.toLong())
        res.addHeader("Cache-Control", "no-cache")
        return res
    }

    private fun json(value: Any?): Response {
        val text = when (value) {
            null -> "null"
            is JSONObject, is JSONArray -> value.toString()
            else -> JSONObject.wrap(value)?.toString() ?: "null"
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", text)
    }

    override fun serve(session: IHTTPSession): Response {
        val pathname = session.uri ?: "/"
        val cookie = session.headers["cookie"]
        if (cookie == null || !cookie.contains("tv_key=$key")) return text(403, "Interdit")
        return try {
            for (route in routes) {
                val match = route.pattern.find(pathname) ?: continue
                if (session.method != route.method) continue
                val profile = Profiles.fromCookie(cookie)
                if (route.access != "public" && profile == null) return text(401, "Aucun compte choisi", fail(401, "noProfile"))
                if (route.access == "admin" && profile!!.role != "admin") return text(403, "Réservé à l'administrateur", fail(403, "adminOnly"))
                val request = Request(session, Params(session.parameters), match, profile)
                val res = when (val out = route.handler(request)) {
                    is Text -> text(out.status, out.text, out.error)
                    is Static -> newFixedLengthResponse(Response.Status.OK, out.mime, ByteArrayInputStream(out.data), out.data.size.toLong())
                    else -> json(out)
                }
                request.cookie?.let { res.addHeader("Set-Cookie", it) }
                return res
            }
            if (session.method == Method.GET) serveStatic(java.net.URLDecoder.decode(pathname.replace("+", "%2B"), "UTF-8"))
            else text(404, "Introuvable")
        } catch (e: ApiError) {
            if (e.status >= 500) Log.error("$pathname : ${e.message}")
            text(e.status, e.message ?: "Erreur", e)
        } catch (e: Exception) {
            val message = listOfNotNull(e.message, e.cause?.javaClass?.simpleName).joinToString(" : ").ifEmpty { e.javaClass.simpleName }
            Log.error("$pathname : $message")
            text(502, message)
        }
    }

    companion object {
        // Corps de la requête (POST, PUT), lu tel quel : NanoHTTPD ne sait lire que les formulaires.
        private fun readBody(session: IHTTPSession, limit: Int): String {
            val length = session.headers["content-length"]?.toIntOrNull() ?: 0
            if (length > limit) throw ApiError(413, "Requête trop volumineuse")
            val buffer = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = session.inputStream.read(buffer, read, length - read)
                if (n < 0) break
                read += n
            }
            return String(buffer, 0, read, Charsets.UTF_8)
        }
    }
}
