package fr.xouxou.tv

import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import android.util.JsonReader
import android.util.JsonToken
import android.util.Xml
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// Base SQLite locale : catalogue (chaînes, films, séries) et guide des programmes (comme lib/db.js).
// Différences : pas de fonctions SQL maison sur Android, donc l'année des films (`year`) et le titre
// normalisé des programmes (`search`) sont calculés à l'import ; pas de JSON1, donc des listes « IN (?, …) ».
object Db {
    lateinit var db: SQLiteDatabase
    private lateinit var cacheDir: File

    fun init(dir: File, cache: File) {
        cacheDir = cache
        db = SQLiteDatabase.openOrCreateDatabase(File(dir, "tv.db"), null)
        db.enableWriteAheadLogging()
        for (sql in SCHEMA.split(";").map { it.trim() }.filter { it.isNotEmpty() }) db.execSQL(sql)
        if (rows("SELECT 1 FROM profiles LIMIT 1").isEmpty()) db.execSQL("INSERT INTO profiles (name, role) VALUES ('Admin', 'admin')")
    }

    private val SCHEMA = """
      CREATE TABLE IF NOT EXISTS categories (type TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (type, id));
      CREATE TABLE IF NOT EXISTS items (
        type TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, search TEXT NOT NULL, logo TEXT, category_id TEXT, ext TEXT,
        archive_days INTEGER NOT NULL DEFAULT 0, rating REAL, added INTEGER, position INTEGER NOT NULL, epg_id TEXT, year INTEGER,
        PRIMARY KEY (type, id));
      CREATE INDEX IF NOT EXISTS items_category ON items (type, category_id, position);
      CREATE INDEX IF NOT EXISTS items_position ON items (type, position);
      CREATE INDEX IF NOT EXISTS items_epg ON items (epg_id);
      CREATE TABLE IF NOT EXISTS programmes (channel TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, search TEXT);
      CREATE INDEX IF NOT EXISTS programmes_channel ON programmes (channel, start);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS hidden (type TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (type, kind, id));
      CREATE TABLE IF NOT EXISTS tmdb (key TEXT PRIMARY KEY, value TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subtitles (media TEXT NOT NULL, file_id TEXT NOT NULL, language TEXT NOT NULL, release TEXT NOT NULL, cues TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (media, file_id));
      CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, password TEXT, groups TEXT)
    """

    // --- Accès SQL : paramètres typés (nombres liés comme nombres, pour LIMIT et les comparaisons) ---

    private fun bind(bindAt: (Int, Any?) -> Unit, args: List<Any?>) = args.forEachIndexed { i, v -> bindAt(i + 1, v) }

    private fun bindStatement(s: SQLiteStatement, args: List<Any?>) = bind({ i, v ->
        when (v) {
            null -> s.bindNull(i)
            is Boolean -> s.bindLong(i, if (v) 1 else 0)
            is Int, is Long -> s.bindLong(i, (v as Number).toLong())
            is Number -> s.bindDouble(i, v.toDouble())
            else -> s.bindString(i, v.toString())
        }
    }, args)

    fun cursor(sql: String, args: List<Any?> = emptyList()): Cursor =
        db.rawQueryWithFactory({ _, driver, table, query ->
            bind({ i, v ->
                when (v) {
                    null -> query.bindNull(i)
                    is Boolean -> query.bindLong(i, if (v) 1 else 0)
                    is Int, is Long -> query.bindLong(i, (v as Number).toLong())
                    is Number -> query.bindDouble(i, v.toDouble())
                    else -> query.bindString(i, v.toString())
                }
            }, args)
            SQLiteCursor(driver, table, query)
        }, sql, null, "")

    fun rows(sql: String, args: List<Any?> = emptyList()): List<JSONObject> {
        cursor(sql, args).use { c ->
            val out = ArrayList<JSONObject>(c.count)
            while (c.moveToNext()) {
                val o = JSONObject()
                for (i in 0 until c.columnCount) {
                    o.put(c.getColumnName(i), when (c.getType(i)) {
                        Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                        Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                        Cursor.FIELD_TYPE_STRING -> c.getString(i)
                        else -> JSONObject.NULL
                    })
                }
                out.add(o)
            }
            return out
        }
    }

    fun row(sql: String, args: List<Any?> = emptyList()) = rows(sql, args).firstOrNull()

    fun run(sql: String, args: List<Any?> = emptyList()): Long {
        val s = db.compileStatement(sql)
        try {
            bindStatement(s, args)
            return if (sql.trimStart().startsWith("INSERT", true)) s.executeInsert() else s.executeUpdateDelete().toLong()
        } finally {
            s.close()
        }
    }

    fun <T> transaction(fn: () -> T): T {
        db.beginTransactionNonExclusive()
        try {
            val result = fn()
            db.setTransactionSuccessful()
            return result
        } finally {
            db.endTransaction()
        }
    }

    fun getMeta(key: String): String? = row("SELECT value FROM meta WHERE key = ?", listOf(key))?.optString("value")?.takeIf { it.isNotEmpty() }
    fun setMeta(key: String, value: String) = run("INSERT OR REPLACE INTO meta VALUES (?, ?)", listOf(key, value))

    private fun marks(n: Int) = List(n) { "?" }.joinToString(",")

    // --- Catalogue ---

    // Année lue dans le nom (« Dune (2021) ») : le dernier nombre plausible l'emporte.
    private val YEARS = Regex("(?<!\\d)(19\\d\\d|20\\d\\d)(?!\\d)")
    fun yearOf(name: String): Int? {
        val max = Calendar.getInstance().get(Calendar.YEAR) + 1
        val years = YEARS.findAll(name).map { it.groupValues[1].toInt() }.filter { it <= max }.toList()
        return if (years.isNotEmpty() && years.last().toString() != name.trim()) years.last() else null
    }

    private val SORTS = mapOf(
        "added" to "added IS NULL, added DESC, position",
        "rating" to "rating IS NULL, rating DESC, position",
        "year" to "year IS NULL, year DESC, position",
        "name" to "search, position",
    )

    private class Source(val categories: String, val items: String, val idField: String, val logoField: String)
    private val SOURCES = linkedMapOf(
        "live" to Source("get_live_categories", "get_live_streams", "stream_id", "stream_icon"),
        "vod" to Source("get_vod_categories", "get_vod_streams", "stream_id", "stream_icon"),
        "series" to Source("get_series_categories", "get_series", "series_id", "cover"),
    )

    // Lit un tableau JSON d'objets au fil de l'eau (les listes de films font des dizaines de Mo) ;
    // seules les valeurs simples sont gardées, en texte.
    private fun eachObject(file: File, fn: (Map<String, String>) -> Unit) {
        JsonReader(file.bufferedReader()).use { r ->
            if (r.peek() != JsonToken.BEGIN_ARRAY) {
                r.skipValue()
                return
            }
            r.beginArray()
            while (r.hasNext()) {
                if (r.peek() != JsonToken.BEGIN_OBJECT) {
                    r.skipValue()
                    continue
                }
                r.beginObject()
                val o = HashMap<String, String>()
                while (r.hasNext()) {
                    val name = r.nextName()
                    when (r.peek()) {
                        JsonToken.STRING, JsonToken.NUMBER -> o[name] = r.nextString()
                        JsonToken.BOOLEAN -> o[name] = if (r.nextBoolean()) "1" else "0"
                        else -> r.skipValue()
                    }
                }
                r.endObject()
                fn(o)
            }
            r.endArray()
        }
    }

    // Avancement de l'import complet, lu par l'interface pendant qu'il tourne (comme lib/db.js).
    private val STEPS = mapOf("account" to 0, "live" to 4, "vod" to 14, "series" to 34, "save" to 50, "epg" to 58, "epgSave" to 82)
    @Volatile private var progress: JSONObject? = null
    private fun step(name: String, percent: Int = STEPS.getValue(name)) {
        if (progress != null) progress = jsonOf("step" to name, "percent" to percent)
    }
    fun syncProgress(): JSONObject? = progress

    private fun syncCatalog() {
        step("account")
        val account = Xtream.apiObject("")
        val dir = File(cacheDir, "sync").apply { mkdirs() }
        val files = HashMap<String, Pair<File, File>>()
        for ((type, source) in SOURCES) {
            step(type)
            Log.log("Import : $type…")
            val categories = File(dir, "$type-categories.json")
            val items = File(dir, "$type-items.json")
            Xtream.apiToFile(source.categories, categories)
            Xtream.apiToFile(source.items, items)
            files[type] = categories to items
        }
        step("save")
        try {
            transaction {
                db.execSQL("DELETE FROM categories")
                db.execSQL("DELETE FROM items")
                val insertCategory = db.compileStatement("INSERT OR REPLACE INTO categories VALUES (?, ?, ?, ?)")
                val insertItem = db.compileStatement(
                    "INSERT OR REPLACE INTO items (type, id, name, search, logo, category_id, ext, archive_days, rating, added, position, epg_id, year) " +
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
                for ((type, source) in SOURCES) {
                    val (categories, items) = files.getValue(type)
                    var i = 0
                    eachObject(categories) { c ->
                        bindStatement(insertCategory, listOf(type, c["category_id"] ?: "", c["category_name"] ?: "", i++))
                        insertCategory.executeInsert()
                    }
                    var position = 0
                    eachObject(items) { x ->
                        val name = (x["name"] ?: "").trim()
                        val archive = if ((x["tv_archive"]?.toDoubleOrNull() ?: 0.0) != 0.0) x["tv_archive_duration"]?.toDoubleOrNull()?.toLong() ?: 0 else 0
                        val rating = x["rating"]?.toDoubleOrNull()?.takeIf { it != 0.0 }
                        val added = (x["added"]?.takeIf { it.isNotEmpty() && it != "0" } ?: x["last_modified"])?.toDoubleOrNull()?.toLong()?.takeIf { it != 0L }
                        bindStatement(insertItem, listOf(
                            type, x[source.idField] ?: "", name, normalize(name), x[source.logoField]?.takeIf { it.isNotEmpty() },
                            x["category_id"] ?: "", if (type == "vod") x["container_extension"]?.takeIf { it.isNotEmpty() } else null,
                            if (type == "live") archive else 0, rating, added, position++,
                            if (type == "live") x["epg_channel_id"]?.lowercase()?.takeIf { it.isNotEmpty() } else null,
                            if (type == "live") null else yearOf(name),
                        ))
                        insertItem.executeInsert()
                    }
                }
                insertCategory.close()
                insertItem.close()
                val timezone = account.optJSONObject("server_info")?.text("timezone")?.takeIf { it.isNotEmpty() } ?: "Europe/Paris"
                setMeta("timezone", timezone)
                setMeta("synced_at", iso(Date()))
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    fun iso(date: Date): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(date)
    private fun parseIso(text: String): Long? = runCatching {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(text)?.time
    }.getOrNull()

    // --- Guide des programmes (XMLTV), lu au fil de l'eau dans une table à part, échangée à la fin ---

    // "20261030173000 +0100" -> timestamp Unix
    private val XMLTV_DATE = Regex("^(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(\\d{2})\\s*([+-])(\\d{2})(\\d{2})")
    private fun parseXmltvDate(text: String): Long? {
        val m = XMLTV_DATE.find(text) ?: return null
        val g = m.groupValues
        val cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        cal.clear()
        cal.set(g[1].toInt(), g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt())
        val offset = (if (g[7] == "-") -1 else 1) * (g[8].toInt() * 60 + g[9].toInt()) * 60
        return cal.timeInMillis / 1000 - offset
    }

    private fun importEpg() {
        Log.log("Import : guide des programmes…")
        step("epg")
        val conn = Xtream.xmltv()
        val length = conn.contentLengthLong
        var count = 0
        try {
            // Le guide est lu et enregistré au fil du téléchargement : l'avancement suit les octets reçus.
            val counting = object : java.io.FilterInputStream(conn.inputStream) {
                var read = 0L
                fun advance(n: Int) {
                    if (n <= 0 || length <= 0) return
                    read += n
                    step("epg", 58 + (42 * read / length).toInt().coerceAtMost(41))
                }
                override fun read(): Int = super.read().also { if (it >= 0) advance(1) }
                override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { advance(it) }
            }
            counting.buffered().use { input ->
                transaction {
                    db.execSQL("DROP TABLE IF EXISTS programmes_new")
                    db.execSQL("CREATE TABLE programmes_new (channel TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT, search TEXT)")
                    val insert = db.compileStatement("INSERT INTO programmes_new VALUES (?, ?, ?, ?, ?, ?)")
                    count = parseXmltv(input) { channel, start, stop, title, desc ->
                        bindStatement(insert, listOf(channel, start, stop, title, desc, normalize(title)))
                        insert.executeInsert()
                    }
                    insert.close()
                    db.execSQL("DROP TABLE programmes")
                    db.execSQL("ALTER TABLE programmes_new RENAME TO programmes")
                    db.execSQL("CREATE INDEX programmes_channel ON programmes (channel, start)")
                    setMeta("epg_synced_at", iso(Date()))
                }
            }
        } finally {
            conn.disconnect()
        }
        Log.log("Guide : $count programmes")
    }

    private fun parseXmltv(input: InputStream, insert: (String, Long, Long, String, String?) -> Unit): Int {
        val p = Xml.newPullParser()
        runCatching { p.setFeature("http://xmlpull.org/v1/doc/features.html#relaxed", true) }
        p.setInput(input, null)
        var count = 0
        var channel = ""
        var start: Long? = null
        var stop: Long? = null
        var title = StringBuilder()
        var desc = StringBuilder()
        var field: StringBuilder? = null
        var inProgramme = false
        var event = p.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            when (event) {
                XmlPullParser.START_TAG -> when (p.name) {
                    "programme" -> {
                        inProgramme = true
                        channel = (p.getAttributeValue(null, "channel") ?: "").lowercase()
                        start = parseXmltvDate(p.getAttributeValue(null, "start") ?: "")
                        stop = parseXmltvDate(p.getAttributeValue(null, "stop") ?: "")
                        title = StringBuilder()
                        desc = StringBuilder()
                    }
                    // Le premier titre et la première description seulement, comme l'expression de epg-worker.js.
                    "title" -> if (inProgramme && title.isEmpty()) field = title
                    "desc" -> if (inProgramme && desc.isEmpty()) field = desc
                }
                XmlPullParser.TEXT -> field?.append(p.text)
                XmlPullParser.END_TAG -> when (p.name) {
                    "title", "desc" -> field = null
                    "programme" -> {
                        inProgramme = false
                        val s = start
                        val e = stop
                        if (s != null && e != null && s != 0L && e != 0L && channel.isNotEmpty()) {
                            insert(channel, s, e, title.toString().trim(), desc.toString().trim().ifEmpty { null })
                            count++
                        }
                    }
                }
            }
            event = p.next()
        }
        return count
    }

    // --- Imports (un seul à la fois) ---

    @Volatile var syncing = false
        private set
    @Volatile private var epgSyncing = false
    private val lock = Object()

    private fun syncEpg() {
        synchronized(lock) {
            if (epgSyncing) return
            epgSyncing = true
        }
        try {
            importEpg()
        } finally {
            epgSyncing = false
        }
    }

    // Import complet, bloquant. Pendant un import, une autre demande attend sa fin et en partage le résultat.
    private var lastError: Exception? = null

    fun sync() {
        synchronized(lock) {
            if (syncing) {
                while (syncing) lock.wait()
                lastError?.let { throw it }
                return
            }
            syncing = true
            progress = jsonOf("step" to "account", "percent" to 0)
        }
        var error: Exception? = null
        try {
            syncCatalog()
            syncEpg()
            Log.log("Import terminé ${counts()}")
        } catch (e: Exception) {
            error = e
            Log.error("Import : ${e.message}")
        } finally {
            synchronized(lock) {
                lastError = error
                syncing = false
                progress = null
                lock.notifyAll()
            }
        }
        error?.let { throw it }
    }

    fun refreshEpgIfStale(maxAgeHours: Int = 12) {
        if (getMeta("synced_at") == null || syncing) return
        val at = getMeta("epg_synced_at")?.let { parseIso(it) }
        if (at != null && System.currentTimeMillis() - at < maxAgeHours * 3600_000L) return
        Thread {
            try {
                syncEpg()
            } catch (e: Exception) {
                Log.error("Guide : ${e.message}")
            }
        }.start()
    }

    fun reset() {
        if (syncing || epgSyncing) throw ApiError(409, "Import en cours, réessaie dans quelques secondes", "importRunning")
        transaction {
            for (table in listOf("categories", "items", "programmes", "meta", "hidden", "tmdb")) db.execSQL("DELETE FROM $table")
        }
    }

    // --- Sous-titres téléchargés, cache TMDB ---

    object SavedSubtitles {
        fun list(media: String) = JSONArray(rows("SELECT file_id AS fileId, language, release FROM subtitles WHERE media = ? ORDER BY at", listOf(media)))
        fun cues(media: String, fileId: String) = row("SELECT cues FROM subtitles WHERE media = ? AND file_id = ?", listOf(media, fileId))?.let { JSONArray(it.getString("cues")) }
        fun anyCues(fileId: String) = row("SELECT cues FROM subtitles WHERE file_id = ? LIMIT 1", listOf(fileId))?.let { JSONArray(it.getString("cues")) }
        fun save(media: String, fileId: String, language: String, release: String, cues: JSONArray) =
            run("INSERT OR REPLACE INTO subtitles VALUES (?, ?, ?, ?, ?, ?)", listOf(media, fileId, language, release, cues.toString(), System.currentTimeMillis()))
    }

    object TmdbCache {
        fun get(key: String): Pair<Any?, Long>? = row("SELECT value, at FROM tmdb WHERE key = ?", listOf(key))?.let {
            org.json.JSONTokener(it.getString("value")).nextValue() to it.getLong("at")
        }
        fun set(key: String, value: Any?) = run("INSERT OR REPLACE INTO tmdb VALUES (?, ?, ?)", listOf(key, (value ?: JSONObject.NULL).let { if (it is String) JSONObject.quote(it) else it.toString() }, System.currentTimeMillis()))
    }

    // --- Comptes ---

    data class Profile(val id: Long, val name: String, val role: String, val password: String?, val groups: Groups?)
    // Groupes autorisés par type ; null pour un compte qui voit tout.
    class Groups(val map: Map<String, List<String>>) {
        operator fun get(type: String): List<String> = map[type] ?: emptyList()
        fun toJson() = JSONObject().apply { for ((k, v) in map) put(k, JSONArray(v)) }
        companion object {
            fun parse(json: JSONObject) = Groups(json.keys().asSequence().associateWith { k ->
                json.optJSONArray(k)?.let { a -> (0 until a.length()).map { a.get(it).toString() } } ?: emptyList()
            })
        }
    }

    object Profiles {
        fun all(): List<Profile> = rows("SELECT * FROM profiles ORDER BY id").map {
            Profile(it.getLong("id"), it.getString("name"), it.getString("role"), it.optString("password").takeIf { p -> !it.isNull("password") && p.isNotEmpty() },
                if (it.isNull("groups")) null else Groups.parse(JSONObject(it.getString("groups"))))
        }
        fun get(id: Long?) = all().find { it.id == id }
        fun create(name: String, role: String, password: String?, groups: Groups?) =
            run("INSERT INTO profiles (name, role, password, groups) VALUES (?, ?, ?, ?)", listOf(name, role, password, groups?.toJson()?.toString()))
        fun update(id: Long, name: String, role: String, password: String?, groups: Groups?) =
            run("UPDATE profiles SET name = ?, role = ?, password = ?, groups = ? WHERE id = ?", listOf(name, role, password, groups?.toJson()?.toString(), id))
        fun remove(id: Long) = run("DELETE FROM profiles WHERE id = ?", listOf(id))
    }

    fun profileJson(p: Profile) = jsonOf("id" to p.id, "name" to p.name, "role" to p.role, "password" to p.password, "groups" to p.groups?.toJson())

    fun backup() = jsonOf(
        "profiles" to JSONArray(Profiles.all().map { profileJson(it) }),
        "hidden" to JSONArray(rows("SELECT type, kind, id FROM hidden")),
    )

    fun restore(profiles: List<Profile>, hidden: List<Triple<String, String, String>>) = transaction {
        db.execSQL("DELETE FROM profiles")
        db.execSQL("DELETE FROM hidden")
        for (p in profiles) run("INSERT INTO profiles (id, name, role, password, groups) VALUES (?, ?, ?, ?, ?)", listOf(p.id, p.name, p.role, p.password, p.groups?.toJson()?.toString()))
        for ((type, kind, id) in hidden) run("INSERT OR IGNORE INTO hidden VALUES (?, ?, ?)", listOf(type, kind, id))
    }

    // --- Lecture ---

    fun counts(): JSONObject {
        val o = JSONObject()
        for (r in rows("SELECT type, COUNT(*) AS n FROM items GROUP BY type")) o.put(r.getString("type"), r.getLong("n"))
        return o
    }

    fun status(): JSONObject {
        val config = Xtream.readConfig()
        return jsonOf(
            "configured" to (config != null),
            "account" to config?.let { jsonOf("server" to it.server, "username" to it.username, "password" to it.password) },
            "syncing" to syncing,
            "syncedAt" to getMeta("synced_at"),
            "epgSyncedAt" to getMeta("epg_synced_at"),
            "counts" to counts(),
        )
    }

    private fun itemHidden(i: String) = "EXISTS (SELECT 1 FROM hidden h WHERE h.type = $i.type AND h.kind = 'item' AND h.id = $i.id)"
    private fun groupHidden(i: String) = "EXISTS (SELECT 1 FROM hidden h WHERE h.type = $i.type AND h.kind = 'category' AND h.id = $i.category_id)"
    private fun visible(i: String) = "NOT ${itemHidden(i)} AND NOT ${groupHidden(i)}"
    private fun separator(i: String) = "($i.type = 'live' AND $i.name GLOB '##*##')"
    // Groupes autorisés : liste vide -> aucun (IN () n'existe pas en SQL).
    private fun allowedGroup(column: String, ids: List<String>) = if (ids.isEmpty()) "0" else "$column IN (${marks(ids.size)})"

    fun categories(type: String, groups: Groups?): JSONArray {
        val allowed = groups?.get(type)
        return JSONArray(rows("""SELECT c.id, c.name, COUNT(i.id) AS count FROM categories c
              JOIN items i ON i.type = c.type AND i.category_id = c.id AND NOT ${separator("i")} AND NOT ${itemHidden("i")}
              WHERE c.type = ? AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.type = c.type AND h.kind = 'category' AND h.id = c.id)
                ${if (allowed != null) "AND ${allowedGroup("c.id", allowed)}" else ""}
              GROUP BY c.id ORDER BY c.position""", listOf(type) + (allowed ?: emptyList())))
    }

    fun manageCategories(type: String) = JSONArray(rows("""SELECT c.id, c.name, COUNT(i.id) AS total, COUNT(h.id) AS removed,
              EXISTS (SELECT 1 FROM hidden g WHERE g.type = c.type AND g.kind = 'category' AND g.id = c.id) AS hidden
              FROM categories c
              LEFT JOIN items i ON i.type = c.type AND i.category_id = c.id AND NOT ${separator("i")}
              LEFT JOIN hidden h ON h.type = i.type AND h.kind = 'item' AND h.id = i.id
              WHERE c.type = ? GROUP BY c.id ORDER BY c.position""", listOf(type)))

    fun setHidden(type: String, kind: String, ids: List<String>, hidden: Boolean) = transaction {
        val sql = if (hidden) "INSERT OR IGNORE INTO hidden VALUES (?, ?, ?)" else "DELETE FROM hidden WHERE type = ? AND kind = ? AND id = ?"
        for (id in ids) run(sql, listOf(type, kind, id))
    }

    const val PAGE_SIZE = 200

    fun list(
        type: String, category: String? = null, ids: List<String>? = null, q: String? = null, offset: Int = 0,
        includeHidden: Boolean = false, groups: Groups? = null, sort: String? = null,
    ): List<JSONObject> {
        val order = if (ids == null) SORTS[sort] else null
        val where = mutableListOf("type = ?")
        val params = mutableListOf<Any?>(type)
        if (!includeHidden) where.add(visible("items"))
        if (groups != null) {
            where.add(allowedGroup("category_id", groups[type]))
            params.addAll(groups[type])
        }
        if (includeHidden || ids != null || !q.isNullOrEmpty() || groups != null || order != null) where.add("NOT ${separator("items")}")
        else where.add("""(NOT ${separator("items")} OR (
            SELECT NOT ${separator("n")} FROM items n
            WHERE n.type = items.type AND n.position > items.position AND ${visible("n")}
              ${if (!category.isNullOrEmpty()) "AND n.category_id = items.category_id" else ""}
            ORDER BY n.position LIMIT 1))""")
        if (ids != null) {
            where.add(if (ids.isEmpty()) "0" else "id IN (${marks(ids.size)})")
            params.addAll(ids)
        } else if (!category.isNullOrEmpty()) {
            where.add("category_id = ?")
            params.add(category)
        }
        if (!q.isNullOrEmpty()) {
            where.add("search LIKE ?")
            params.add("%${normalize(q)}%")
        }
        if (ids != null) params.add(",${ids.joinToString(",")},")
        params.add(PAGE_SIZE)
        params.add(offset)
        return rows("""SELECT id, name, logo, category_id AS category, ext, archive_days AS archiveDays, added, rating,
                     ${itemHidden("items")} AS hidden, ${groupHidden("items")} AS groupHidden, ${separator("items")} AS separator
              FROM items WHERE ${where.joinToString(" AND ")} ORDER BY ${if (ids != null) "instr(?, ',' || id || ',')" else order ?: "position"} LIMIT ? OFFSET ?""", params)
    }

    fun itemAllowed(type: String, id: String, groups: Groups?): Boolean {
        val r = row("SELECT category_id AS category, ${visible("items")} AS shown FROM items WHERE type = ? AND id = ?", listOf(type, id)) ?: return false
        return r.optLong("shown") != 0L && (groups == null || groups[type].contains(r.optString("category")))
    }

    // --- Versions : la même chaîne ou le même film dans une autre qualité ---

    private val VERSION_TAGS = ("sd hd fhd uhd qhd hq lq 4k 8k hevc h264 h265 x264 x265 avc 720p 1080p 1080i 2160p 720 1080 2160 " +
        "hdr hdr10 dv dolby vision atmos 50fps 60fps fps multi vf vff vfq vfi vo vost vostfr vosta fr fra french en eng english " +
        "ar arabic subt sub subs backup raw").split(" ").toSet()

    data class VersionKey(val words: List<String>, val year: String?)

    private val COUNTRY = Regex("^\\s*[|\\[]?\\s*[a-z]{2,3}\\s*[|\\]:]\\s*")
    private val LANGUAGE = Regex("^\\s*[a-z]{2,4}\\s+-\\s+")
    private val PLUS = Regex("\\s*\\+")
    private val OTHER = Regex("[^\\p{L}\\p{N}+]+")
    private val YEAR = Regex("^(19|20)\\d\\d$")

    fun versionKey(name: String): VersionKey {
        var text = normalize(name).replaceFirst(COUNTRY, "").replaceFirst(LANGUAGE, "")
        text = PLUS.replace(text, "+")
        text = OTHER.replace(text, " ")
        val all = text.split(" ").filter { it.isNotEmpty() }
        var words = all
        var year: String? = null
        for (i in words.indices.reversed()) {
            if (i == 0) break
            if (YEAR.matches(words[i])) {
                year = words[i]
                words = words.filterIndexed { j, _ -> j != i }
                break
            }
        }
        while (words.isNotEmpty() && words.last() in VERSION_TAGS) words = words.dropLast(1)
        while (words.isNotEmpty() && words.first() in VERSION_TAGS) words = words.drop(1)
        if (words.isEmpty()) words = all
        return VersionKey(words, year)
    }

    private fun sameVersion(a: VersionKey, b: VersionKey) =
        a.words.joinToString(" ") == b.words.joinToString(" ") && (a.year == null || b.year == null || a.year == b.year)

    fun versions(type: String, id: String, q: String?, groups: Groups?): JSONObject? {
        val item = row("SELECT name FROM items WHERE type = ? AND id = ?", listOf(type, id)) ?: return null
        val key = versionKey(item.getString("name"))
        val query = key.words.joinToString(" ")
        val words = normalize(q ?: query).split(Regex("[\\s+]+")).filter { it.isNotEmpty() }.take(8)
        if (words.isEmpty()) return jsonOf("query" to query, "items" to JSONArray())
        val where = mutableListOf("i.type = ?", "NOT ${separator("i")}") + words.map { "i.search LIKE ?" }
        val params = mutableListOf<Any?>(type) + words.map { "%$it%" }
        val allWhere = where.toMutableList()
        val allParams = params.toMutableList()
        if (groups != null) {
            allWhere.add(visible("i"))
            allWhere.add(allowedGroup("i.category_id", groups[type]))
            allParams.addAll(groups[type])
        }
        val found = rows("""SELECT i.id, i.name, i.logo, i.ext, c.name AS category, NOT (${visible("i")}) AS hidden FROM items i
              LEFT JOIN categories c ON c.type = i.type AND c.id = i.category_id
              WHERE ${allWhere.joinToString(" AND ")} ORDER BY i.position LIMIT 300""", allParams).map {
            it.put("hidden", it.optLong("hidden") != 0L)
            it.put("same", sameVersion(key, versionKey(it.getString("name"))))
        }
        fun rank(r: JSONObject) = (if (r.getBoolean("same")) 0 else 2) + (if (r.getBoolean("hidden")) 1 else 0)
        return jsonOf("query" to query, "items" to JSONArray(found.sortedBy { rank(it) }.take(150)))
    }

    // Format attendu par /timeshift : "AAAA-MM-JJ:HH-mm" dans le fuseau du fournisseur.
    fun replayStart(timestamp: Long): String =
        SimpleDateFormat("yyyy-MM-dd:HH-mm", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone(getMeta("timezone") ?: "Europe/Paris") }.format(Date(timestamp * 1000))

    private fun programme(r: JSONObject) = jsonOf(
        "start" to r.getLong("start"), "stop" to r.getLong("stop"), "title" to r.getString("title"),
        "description" to r.opt("description"), "replayStart" to replayStart(r.getLong("start")),
    )

    fun guide(category: String?, ids: List<String>?, q: String?, offset: Int, at: Long, evening: Long?, perChannel: Int, groups: Groups?): JSONArray {
        val channels = list("live", category, ids, q, offset, groups = groups).map {
            jsonOf("id" to it.get("id"), "name" to it.get("name"), "logo" to it.opt("logo"), "archiveDays" to it.get("archiveDays"),
                "category" to it.opt("category"), "separator" to it.get("separator"), "programmes" to JSONArray(), "evening" to null)
        }
        val byId = channels.filter { it.optLong("separator") == 0L }.associateBy { it.getString("id") }
        if (byId.isEmpty()) return JSONArray(channels)
        val keys = byId.keys.toList()
        for (r in rows("""SELECT i.id, p.start, p.stop, p.title, p.description
              FROM items i JOIN programmes p ON p.channel = i.epg_id AND p.stop > ? AND p.start < ?
              WHERE i.type = 'live' AND i.id IN (${marks(keys.size)}) ORDER BY p.start""", listOf<Any?>(at, at + 8 * 3600) + keys)) {
            val list = byId.getValue(r.getString("id")).getJSONArray("programmes")
            val previous = if (list.length() > 0) list.getJSONObject(list.length() - 1) else null
            if (list.length() >= perChannel || (previous != null && r.getLong("start") < previous.getLong("stop"))) continue
            list.put(programme(r))
        }
        if (evening != null) {
            for (r in rows("""SELECT i.id, p.start, p.stop, p.title, p.description
                  FROM items i JOIN programmes p ON p.channel = i.epg_id AND p.start <= ? AND p.stop > ?
                  WHERE i.type = 'live' AND i.id IN (${marks(keys.size)}) ORDER BY p.start""", listOf<Any?>(evening, evening) + keys)) {
                val channel = byId.getValue(r.getString("id"))
                if (channel.isNull("evening")) channel.put("evening", programme(r))
            }
        }
        return JSONArray(channels)
    }

    fun searchProgrammes(q: String?, at: Long, groups: Groups?): JSONArray {
        val words = normalize(q ?: "").split(Regex("\\s+")).filter { it.isNotEmpty() }.take(8)
        if (words.isEmpty()) return JSONArray()
        val where = mutableListOf("i.type = 'live'", visible("i"), "NOT ${separator("i")}", "p.stop > ?") + words.map { "p.search LIKE ?" }
        val params = mutableListOf<Any?>(at - 7 * 86400) + words.map { "%$it%" }
        val w = where.toMutableList()
        val ps = params.toMutableList()
        if (groups != null) {
            w.add(allowedGroup("i.category_id", groups["live"]))
            ps.addAll(groups["live"])
        }
        val found = rows("""SELECT i.id, i.name, i.logo, i.archive_days AS archiveDays, min(i.position) AS position, p.start, p.stop, p.title, p.description
              FROM programmes p JOIN items i ON i.epg_id = p.channel
              WHERE ${w.joinToString(" AND ")} GROUP BY p.channel, p.start""", ps)
        fun order(p: JSONObject) = if (p.getLong("start") <= at) (if (p.getLong("stop") > at) 0 else 2) else 1
        val sorted = found
            .filter { it.getLong("stop") > at || (it.getLong("archiveDays") > 0 && it.getLong("start") > at - it.getLong("archiveDays") * 86400) }
            .sortedWith { a, b ->
                val o = order(a) - order(b)
                if (o != 0) o else if (order(a) == 2) b.getLong("start").compareTo(a.getLong("start")) else a.getLong("start").compareTo(b.getLong("start"))
            }
            .take(100)
        return JSONArray(sorted.map {
            jsonOf(
                "channel" to jsonOf("id" to it.get("id"), "name" to it.get("name"), "logo" to it.opt("logo"), "archiveDays" to it.get("archiveDays")),
                "start" to it.getLong("start"), "stop" to it.getLong("stop"), "title" to it.getString("title"), "description" to it.opt("description"),
                "replayStart" to replayStart(it.getLong("start")), "archive" to (it.getLong("stop") <= at),
            )
        })
    }

    fun channelProgrammes(id: String): JSONArray {
        val now = System.currentTimeMillis() / 1000.0
        val out = JSONArray()
        var lastEnd = Long.MIN_VALUE
        for (r in rows("""SELECT i.archive_days AS archiveDays, p.start, p.stop, p.title, p.description
              FROM items i JOIN programmes p ON p.channel = i.epg_id WHERE i.type = 'live' AND i.id = ? ORDER BY p.start""", listOf(id))) {
            val start = r.getLong("start")
            val stop = r.getLong("stop")
            if (out.length() > 0 && start < lastEnd) continue
            lastEnd = stop
            out.put(jsonOf("title" to r.getString("title"), "description" to r.opt("description"), "start" to start, "end" to stop,
                "replayStart" to replayStart(start), "archive" to (stop < now && start > now - r.getLong("archiveDays") * 86400)))
        }
        return out
    }
}
