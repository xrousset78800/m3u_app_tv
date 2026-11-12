package fr.xouxou.tv

import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// Accès au fournisseur (API « Xtream Codes ») : identifiants et appels HTTP (comme lib/xtream.js).
object Xtream {
    const val USER_AGENT = "VLC/3.0.20 LibVLC/3.0.20"
    private lateinit var configFile: File

    data class Config(val server: String, val username: String, val password: String)

    @Volatile
    private var config: Config? = null

    fun init(dir: File) {
        configFile = File(dir, "config.json")
    }

    @Synchronized
    fun readConfig(): Config? {
        if (config == null && configFile.exists()) {
            val o = JSONObject(configFile.readText())
            config = Config(o.getString("server"), o.getString("username"), o.getString("password"))
        }
        return config
    }

    private fun query(vararg pairs: Pair<String, String>) =
        pairs.joinToString("&") { (k, v) -> "${URLEncoder.encode(k, "UTF-8")}=${URLEncoder.encode(v, "UTF-8")}" }

    // "exemple.com", "http://exemple.com:8080/" … -> "http://exemple.com:8080"
    private fun normalizeServer(text: String): String {
        try {
            val url = URL(if (Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(text)) text else "http://$text")
            if (url.host.isNullOrEmpty()) throw IllegalArgumentException()
            val port = if (url.port == -1 || url.port == url.defaultPort) "" else ":${url.port}"
            return "${url.protocol.lowercase()}://${url.host.lowercase()}$port"
        } catch (e: Exception) {
            throw ApiError(400, "Adresse de serveur invalide : $text", "invalidServer", mapOf("server" to text))
        }
    }

    fun headers() = mapOf("User-Agent" to USER_AGENT)

    // Vérifie les accès auprès du fournisseur puis les enregistre dans config.json.
    fun login(input: JSONObject) {
        val server = input.text("server").trim()
        val username = input.text("username").trim()
        val password = input.text("password").trim()
        if (server.isEmpty() || username.isEmpty() || password.isEmpty()) {
            throw ApiError(400, "Serveur, utilisateur et mot de passe sont requis", "missingFields")
        }
        val candidate = Config(normalizeServer(server), username, password)
        val info = try {
            val res = Http.request("${candidate.server}/player_api.php?${query("username" to username, "password" to password)}", headers = headers(), timeoutMs = 15000)
            if (isWebPage(res.type)) throw providerPageError()
            if (res.status == 401 || res.status == 403) JSONObject() else JSONObject(res.text())
        } catch (e: Exception) {
            if (e is ApiError && e.key == "providerPage") throw e
            throw ApiError(502, "Pas de réponse Xtream Codes de ${candidate.server} : vérifie l'adresse du serveur", "noResponse", mapOf("server" to candidate.server))
        }
        val user = info.optJSONObject("user_info") ?: JSONObject()
        if (user.text("auth") != "1") throw ApiError(401, "Identifiants refusés par le serveur", "badCredentials")
        val status = user.text("status")
        if (status.isNotEmpty() && status != "Active") throw ApiError(403, "Abonnement non actif ($status)", "inactive", mapOf("status" to status))
        synchronized(this) {
            config = candidate
            configFile.writeText(JSONObject().put("server", candidate.server).put("username", username).put("password", password).toString(2))
        }
        Log.log("Connecté : $username sur ${candidate.server}")
    }

    @Synchronized
    fun forgetConfig() {
        config = null
        configFile.delete()
    }

    fun requireConfig(): Config =
        readConfig() ?: throw ApiError(502, "Pas encore configuré : lancer l'import", "notConfigured")

    private fun apiUrl(action: String, params: Map<String, String>): String {
        val c = requireConfig()
        val pairs = listOf("username" to c.username, "password" to c.password, "action" to action) + params.toList()
        return "${c.server}/player_api.php?${query(*pairs.toTypedArray())}"
    }

    // Une page web à la place des données : adresse bloquée par l'opérateur internet, ou serveur hors service.
    private fun isWebPage(type: String?) = type?.contains("text/html", ignoreCase = true) == true
    private fun providerPageError() = ApiError(502, "Le fournisseur renvoie une page web au lieu de ses données : adresse bloquée par l'opérateur internet, ou serveur hors service", "providerPage")

    // Après un échec de lecture : le fournisseur répond-il encore normalement ?
    // "ok", "page" (page web à la place des données) ou "down" (pas de réponse). Aucun flux n'est ouvert.
    fun checkProvider(): String {
        val c = requireConfig()
        return try {
            val res = Http.request("${c.server}/player_api.php?${query("username" to c.username, "password" to c.password)}", headers = headers(), timeoutMs = 10000)
            when {
                isWebPage(res.type) -> "page"
                res.ok -> "ok"
                else -> "down"
            }
        } catch (e: Exception) {
            "down"
        }
    }

    // Réponse JSON (objet ou tableau) ; les fournisseurs renvoient parfois [] au lieu de {}.
    fun api(action: String, params: Map<String, String> = emptyMap()): Any? {
        val res = Http.request(apiUrl(action, params), headers = headers(), timeoutMs = 60000)
        if (!res.ok) throw Exception("API $action : HTTP ${res.status}")
        if (isWebPage(res.type)) throw providerPageError()
        val text = res.text().trim()
        if (text.isEmpty()) return null
        return JSONTokener(text).nextValue()
    }

    fun apiObject(action: String, params: Map<String, String> = emptyMap()): JSONObject = api(action, params) as? JSONObject ?: JSONObject()

    // Grande réponse (listes du catalogue) : écrite dans un fichier, lue ensuite au fil de l'eau.
    fun apiToFile(action: String, file: File) {
        val c = Http.open(apiUrl(action, emptyMap()), headers = headers(), timeoutMs = 120000)
        try {
            if (c.responseCode !in 200..299) throw Exception("API $action : HTTP ${c.responseCode}")
            if (isWebPage(c.contentType)) throw providerPageError()
            c.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
        } finally {
            c.disconnect()
        }
    }

    // Guide des programmes complet au format XMLTV (environ 3 jours, toutes chaînes).
    fun xmltv(): HttpURLConnection {
        val c = requireConfig()
        val conn = Http.open("${c.server}/xmltv.php?${query("username" to c.username, "password" to c.password)}", headers = headers(), timeoutMs = 120000)
        if (conn.responseCode !in 200..299) {
            conn.disconnect()
            throw Exception("XMLTV : HTTP ${conn.responseCode}")
        }
        if (isWebPage(conn.contentType)) {
            conn.disconnect()
            throw providerPageError()
        }
        return conn
    }

    // URL des flux côté fournisseur (elles redirigent vers un serveur de diffusion avec jeton).
    fun liveUrl(id: String) = requireConfig().let { "${it.server}/live/${it.username}/${it.password}/$id.m3u8" }
    fun liveRawUrl(id: String) = requireConfig().let { "${it.server}/${it.username}/${it.password}/$id" }
    fun replayUrl(id: String, start: String, minutes: Int) = requireConfig().let { "${it.server}/timeshift/${it.username}/${it.password}/$minutes/$start/$id.m3u8" }
    fun mediaUrl(kind: String, id: String, ext: String) = requireConfig().let { "${it.server}/$kind/${it.username}/${it.password}/$id.$ext" }
}
