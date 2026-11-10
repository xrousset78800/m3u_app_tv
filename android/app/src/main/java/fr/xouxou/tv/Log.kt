package fr.xouxou.tv

import java.io.File
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

// Journal de l'appli (tv.log, comme lib/log.js) : ouvertures des flux, erreurs, attentes du lecteur.
// Rien qui permette de joindre l'abonnement : adresses, hôtes, identifiants et mot de passe sont masqués.
// Au-delà de 2 Mo, il devient tv.old.log et un nouveau commence.
object Log {
    private const val MAX_SIZE = 2L * 1024 * 1024
    private lateinit var file: File
    private lateinit var old: File
    private val hosts = ConcurrentHashMap.newKeySet<String>()
    private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT)

    fun init(dir: File) {
        file = File(dir, "tv.log")
        old = File(dir, "tv.old.log")
        write("log", "--- démarrage ---")
    }

    // Hôtes de diffusion découverts en cours de route (redirections du fournisseur).
    fun secret(host: String?) {
        if (!host.isNullOrEmpty()) hosts.add(host)
    }

    private val URLS = Regex("\\b(?:https?|rtmp|rtsp)://[^\\s\"'<>]+", RegexOption.IGNORE_CASE)
    private val LOCAL = Regex("^https?://(localhost|127\\.0\\.0\\.1)[:/]", RegexOption.IGNORE_CASE)
    private val IPS = Regex("\\b(?!127\\.0\\.0\\.1\\b)\\d{1,3}(?:\\.\\d{1,3}){3}\\b")

    fun redact(text: String): String {
        var out = URLS.replace(text) { if (LOCAL.containsMatchIn(it.value)) it.value else "<url>" }
        out = IPS.replace(out, "<ip>")
        val config = runCatching { Xtream.readConfig() }.getOrNull()
        val server = runCatching { config?.let { URL(it.server).host } }.getOrNull()
        for (value in listOfNotNull(server, config?.username, config?.password) + hosts) {
            if (value.length >= 3) out = out.replace(value, "<…>", ignoreCase = true)
        }
        return out
    }

    fun log(text: String) = write("log", text)
    fun warn(text: String) = write("warn", text)
    fun error(text: String) = write("error", text)

    @Synchronized
    private fun write(level: String, text: String) {
        val line = redact(text)
        android.util.Log.i("TV", line)
        if (!::file.isInitialized) return
        try {
            if (file.length() > MAX_SIZE) {
                old.delete()
                file.renameTo(old)
            }
            file.appendText("${stamp.format(Date())} ${if (level == "log") "" else "${level.uppercase()} "}$line\n")
        } catch (_: Exception) {
        }
    }
}
