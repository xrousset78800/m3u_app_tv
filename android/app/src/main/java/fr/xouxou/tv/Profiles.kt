package fr.xouxou.tv

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

// scrypt (N=16384, r=8, p=1, 32 octets), comme crypto.scryptSync de Node : les mots de passe
// d'une sauvegarde passent de l'appli Windows à la télé et inversement.
object Scrypt {
    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val block = 64
        val k = if (key.size > block) MessageDigest.getInstance("SHA-256").digest(key) else key
        val ipad = ByteArray(block) { ((if (it < k.size) k[it].toInt() else 0) xor 0x36).toByte() }
        val opad = ByteArray(block) { ((if (it < k.size) k[it].toInt() else 0) xor 0x5c).toByte() }
        val sha = MessageDigest.getInstance("SHA-256")
        sha.update(ipad)
        val inner = sha.digest(data)
        sha.update(opad)
        return sha.digest(inner)
    }

    private fun pbkdf2(password: ByteArray, salt: ByteArray, length: Int): ByteArray {
        val out = ByteArray(length)
        var block = 1
        var offset = 0
        while (offset < length) {
            val u = hmac(password, salt + byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
            val n = minOf(32, length - offset)
            System.arraycopy(u, 0, out, offset, n)
            offset += n
            block++
        }
        return out
    }

    private fun salsa(b: IntArray) {
        val x = b.copyOf()
        fun r(a: Int, n: Int) = (a shl n) or (a ushr (32 - n))
        repeat(4) {
            x[4] = x[4] xor r(x[0] + x[12], 7); x[8] = x[8] xor r(x[4] + x[0], 9)
            x[12] = x[12] xor r(x[8] + x[4], 13); x[0] = x[0] xor r(x[12] + x[8], 18)
            x[9] = x[9] xor r(x[5] + x[1], 7); x[13] = x[13] xor r(x[9] + x[5], 9)
            x[1] = x[1] xor r(x[13] + x[9], 13); x[5] = x[5] xor r(x[1] + x[13], 18)
            x[14] = x[14] xor r(x[10] + x[6], 7); x[2] = x[2] xor r(x[14] + x[10], 9)
            x[6] = x[6] xor r(x[2] + x[14], 13); x[10] = x[10] xor r(x[6] + x[2], 18)
            x[3] = x[3] xor r(x[15] + x[11], 7); x[7] = x[7] xor r(x[3] + x[15], 9)
            x[11] = x[11] xor r(x[7] + x[3], 13); x[15] = x[15] xor r(x[11] + x[7], 18)
            x[1] = x[1] xor r(x[0] + x[3], 7); x[2] = x[2] xor r(x[1] + x[0], 9)
            x[3] = x[3] xor r(x[2] + x[1], 13); x[0] = x[0] xor r(x[3] + x[2], 18)
            x[6] = x[6] xor r(x[5] + x[4], 7); x[7] = x[7] xor r(x[6] + x[5], 9)
            x[4] = x[4] xor r(x[7] + x[6], 13); x[5] = x[5] xor r(x[4] + x[7], 18)
            x[11] = x[11] xor r(x[10] + x[9], 7); x[8] = x[8] xor r(x[11] + x[10], 9)
            x[9] = x[9] xor r(x[8] + x[11], 13); x[10] = x[10] xor r(x[9] + x[8], 18)
            x[12] = x[12] xor r(x[15] + x[14], 7); x[13] = x[13] xor r(x[12] + x[15], 9)
            x[14] = x[14] xor r(x[13] + x[12], 13); x[15] = x[15] xor r(x[14] + x[13], 18)
        }
        for (i in 0 until 16) b[i] += x[i]
    }

    // BlockMix sur 2r blocs de 16 mots.
    private fun blockMix(b: IntArray, y: IntArray, r: Int) {
        val x = b.copyOfRange((2 * r - 1) * 16, 2 * r * 16)
        for (i in 0 until 2 * r) {
            for (j in 0 until 16) x[j] = x[j] xor b[i * 16 + j]
            salsa(x)
            val dest = (if (i % 2 == 0) i / 2 else r + i / 2) * 16
            System.arraycopy(x, 0, y, dest, 16)
        }
    }

    fun derive(password: ByteArray, salt: ByteArray, n: Int = 16384, r: Int = 8, length: Int = 32): ByteArray {
        val words = 32 * r
        val b = pbkdf2(password, salt, 128 * r)
        val x = IntArray(words) { i ->
            (b[i * 4].toInt() and 0xff) or ((b[i * 4 + 1].toInt() and 0xff) shl 8) or ((b[i * 4 + 2].toInt() and 0xff) shl 16) or ((b[i * 4 + 3].toInt() and 0xff) shl 24)
        }
        val v = IntArray(words * n)
        val y = IntArray(words)
        for (i in 0 until n) {
            System.arraycopy(x, 0, v, i * words, words)
            blockMix(x, y, r)
            System.arraycopy(y, 0, x, 0, words)
        }
        for (i in 0 until n) {
            val j = x[(2 * r - 1) * 16] and (n - 1)
            for (k in 0 until words) x[k] = x[k] xor v[j * words + k]
            blockMix(x, y, r)
            System.arraycopy(y, 0, x, 0, words)
        }
        val mixed = ByteArray(words * 4)
        for (i in 0 until words) {
            mixed[i * 4] = x[i].toByte(); mixed[i * 4 + 1] = (x[i] ushr 8).toByte()
            mixed[i * 4 + 2] = (x[i] ushr 16).toByte(); mixed[i * 4 + 3] = (x[i] ushr 24).toByte()
        }
        return pbkdf2(password, mixed, length)
    }
}

fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
fun String.unhex() = ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }

// Comptes de l'appli (comme lib/profiles.js) : session retenue par un cookie jusqu'à la fermeture de l'appli.
object Profiles {
    private val ROLES = listOf("admin", "standard", "child")
    private val TYPES = listOf("live", "vod", "series")
    private const val COOKIE = "tv_profile"
    private val random = SecureRandom()

    class Session(val id: Long, val episodes: MutableSet<String> = ConcurrentHashMap.newKeySet())
    private val sessions = ConcurrentHashMap<String, Session>()

    class Current(val id: Long, val name: String, val role: String, val locked: Boolean, val groups: Db.Groups?, val session: Session, val token: String)

    private fun hash(password: String): String {
        val salt = ByteArray(16).also { random.nextBytes(it) }
        return "${salt.hex()}:${Scrypt.derive(password.toByteArray(), salt).hex()}"
    }

    private fun verify(password: String, stored: String): Boolean {
        val (salt, expected) = stored.split(":")
        return MessageDigest.isEqual(Scrypt.derive(password.toByteArray(), salt.unhex()), expected.unhex())
    }

    fun summary(p: Db.Profile) = jsonOf("id" to p.id, "name" to p.name, "role" to p.role, "locked" to (p.password != null), "groups" to p.groups?.toJson())

    fun list() = JSONArray(Db.Profiles.all().map { summary(it) })

    private val TOKEN = Regex("(?:^|;\\s*)tv_profile=([0-9a-f]{64})")
    fun token(cookie: String?) = cookie?.let { TOKEN.find(it)?.groupValues?.get(1) }

    fun fromCookie(cookie: String?): Current? {
        val token = token(cookie) ?: return null
        val session = sessions[token] ?: return null
        val p = Db.Profiles.get(session.id) ?: return null
        return Current(p.id, p.name, p.role, p.password != null, p.groups, session, token)
    }

    fun open(p: Db.Profile): String {
        val token = ByteArray(32).also { random.nextBytes(it) }.hex()
        sessions[token] = Session(p.id)
        return "$COOKIE=$token; Path=/; HttpOnly; SameSite=Strict"
    }

    fun select(id: Long?, password: String?): String {
        val p = Db.Profiles.get(id) ?: throw fail(404, "profileMissing")
        if (p.password != null && !verify(password ?: "", p.password)) {
            Thread.sleep(600)
            throw fail(403, "wrongPassword")
        }
        return open(p)
    }

    fun close(cookie: String?): String {
        token(cookie)?.let { sessions.remove(it) }
        return "$COOKIE=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
    }

    fun automatic(): Db.Profile? = Db.Profiles.all().let { if (it.size == 1 && it[0].password == null) it[0] else null }

    private fun cleanGroups(groups: Any?): Db.Groups? {
        if (groups == null || groups == JSONObject.NULL) return null
        if (groups !is JSONObject) throw fail(400, "invalidProfile")
        return Db.Groups(TYPES.associateWith { type ->
            val ids = groups.opt(type) ?: JSONArray()
            if (ids == JSONObject.NULL) return@associateWith emptyList()
            if (ids !is JSONArray) throw fail(400, "invalidProfile")
            (0 until ids.length()).map { (ids.get(it) as? String) ?: throw fail(400, "invalidProfile") }.distinct()
        })
    }

    private class Clean(val name: String, val role: String, val password: String?, val groups: Db.Groups?)

    // `password` : absent, on garde l'actuel ; "" l'enlève ; sinon le nouveau.
    private fun clean(input: JSONObject, current: Db.Profile?, keepPassword: Boolean = false): Clean {
        val name = (if (input.has("name") && !input.isNull("name")) input.text("name") else current?.name ?: "").trim().take(40)
        val role = if (input.has("role") && !input.isNull("role")) input.opt("role") as? String ?: "" else current?.role ?: ""
        if (name.isEmpty() || role !in ROLES) throw fail(400, "invalidProfile")
        var password = current?.password
        if (!keepPassword && input.opt("password") is String) {
            val p = input.getString("password")
            password = if (p.isNotEmpty()) hash(p) else null
        }
        val groups = if (role == "admin") null else cleanGroups(
            if (input.has("groups")) input.opt("groups") else current?.groups?.toJson() ?: if (role == "child") JSONObject() else null,
        )
        return Clean(name, role, password, groups)
    }

    private fun admins() = Db.Profiles.all().filter { it.role == "admin" }

    fun create(input: JSONObject): Long = clean(input, null).let { Db.Profiles.create(it.name, it.role, it.password, it.groups) }

    fun update(id: Long?, input: JSONObject) {
        val current = Db.Profiles.get(id) ?: throw fail(404, "profileMissing")
        val next = clean(input, current)
        if (current.role == "admin" && next.role != "admin" && admins().size == 1) throw fail(409, "lastAdmin")
        Db.Profiles.update(current.id, next.name, next.role, next.password, next.groups)
    }

    fun remove(id: Long?, self: Long) {
        val current = Db.Profiles.get(id) ?: throw fail(404, "profileMissing")
        if (current.id == self) throw fail(409, "deleteSelf")
        if (current.role == "admin" && admins().size == 1) throw fail(409, "lastAdmin")
        Db.Profiles.remove(current.id)
        sessions.entries.removeAll { it.value.id == current.id }
    }

    private val STORED = Regex("^[0-9a-f]{32}:[0-9a-f]{64}$")

    fun restore(input: Any?): List<Db.Profile> {
        val list = (input as? JSONArray)?.let { a -> (0 until a.length()).map { a.opt(it) } } ?: emptyList()
        val seen = HashSet<Long>()
        val restored = list.map { item ->
            val p = item as? JSONObject ?: throw fail(400, "badBackup")
            val idValue = p.opt("id")
            val id = (idValue as? Number)?.toDouble()?.takeIf { it == Math.floor(it) && it >= 1 }?.toLong() ?: throw fail(400, "badBackup")
            if (!seen.add(id)) throw fail(400, "badBackup")
            val c = clean(p, null, keepPassword = true)
            val password = if (p.isNull("password")) null else p.opt("password") as? String ?: throw fail(400, "badBackup")
            if (password != null && !STORED.matches(password)) throw fail(400, "badBackup")
            Db.Profile(id, c.name, c.role, password, c.groups)
        }
        if (restored.none { it.role == "admin" }) throw fail(400, "badBackup")
        sessions.clear()
        return restored
    }
}
