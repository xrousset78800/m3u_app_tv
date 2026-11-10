package fr.xouxou.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.annotation.OptIn
import androidx.core.content.FileProvider
import androidx.media3.common.Player as MediaPlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.AspectRatioFrameLayout
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

@OptIn(UnstableApi::class)
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newCachedThreadPool()
    private lateinit var server: Server
    private lateinit var web: WebView
    private lateinit var videoBox: FrameLayout
    private lateinit var aspect: AspectRatioFrameLayout
    private lateinit var base: String

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.init(filesDir)
        Log.log("Démarrage v${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}, ${Build.MANUFACTURER} ${Build.MODEL})")
        Xtream.init(filesDir)
        Xtream.readConfig()?.let { runCatching { Log.secret(java.net.URL(it.server).host) } }
        Db.init(filesDir, cacheDir)
        val languages = assets.open("public/i18n/languages.json").use { String(Http.readAll(it), Charsets.UTF_8) }
        Tmdb.init(languages)
        Player.init(this)

        // Vidéo dessous, page par-dessus : la page laisse voir la vidéo à l'emplacement de son <video>.
        val root = FrameLayout(this).apply { setBackgroundColor(0xFF111111.toInt()) }
        videoBox = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); visibility = View.INVISIBLE }
        aspect = AspectRatioFrameLayout(this).apply { resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT }
        val surface = SurfaceView(this)
        aspect.addView(surface, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        videoBox.addView(aspect, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, android.view.Gravity.CENTER))
        root.addView(videoBox, FrameLayout.LayoutParams(0, 0))
        web = WebView(this)
        web.setBackgroundColor(Color.TRANSPARENT)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        Player.exo.setVideoSurfaceView(surface)

        Player.onVideoSize = { size ->
            if (size.width > 0 && size.height > 0) aspect.setAspectRatio(size.width * size.pixelWidthHeightRatio / size.height)
        }
        Player.send = { state -> web.evaluateJavascript("window.tvPlayer && tvPlayer.event($state)", null) }
        Player.exo.addListener(object : MediaPlayer.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        })

        server = Server(assets, languages)
        server.start(NanoHttpdTimeout, true)
        base = "http://127.0.0.1:${server.listeningPort}"
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(base, "tv_key=${server.key}; Path=/")
            flush()
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
        }
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        web.webViewClient = object : WebViewClient() {
            // Liens externes (TMDB, aide…) : hors de l'appli.
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith(base)) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.webChromeClient = WebChromeClient()
        web.addJavascriptInterface(Bridge(), "TVNative")
        web.loadUrl("$base/")
        web.requestFocus()

        // Guide des programmes : rafraîchi après le lancement, puis toutes les heures.
        main.postDelayed(object : Runnable {
            override fun run() {
                work.execute { runCatching { Db.refreshEpgIfStale() } }
                main.postDelayed(this, 3600_000)
            }
        }, 15_000)
        work.execute { checkUpdate() }
    }

    // Emplacement du <video> dans la page, en fraction de la fenêtre (la page est mise à l'échelle).
    private fun place(left: Double, top: Double, width: Double, height: Double) {
        val w = web.width
        val h = web.height
        if (w == 0 || width <= 0 || height <= 0) {
            videoBox.visibility = View.INVISIBLE
            return
        }
        val params = videoBox.layoutParams as FrameLayout.LayoutParams
        params.leftMargin = Math.round(left * w).toInt()
        params.topMargin = Math.round(top * h).toInt()
        params.width = Math.max(1, Math.round(width * w).toInt())
        params.height = Math.max(1, Math.round(height * h).toInt())
        videoBox.layoutParams = params
        videoBox.visibility = View.VISIBLE
    }

    private fun cookie() = CookieManager.getInstance().getCookie(base)

    // Appels de la page (tv.js) : fil du pont, renvoyés sur le fil principal.
    inner class Bridge {
        @JavascriptInterface
        fun load(id: Int, src: String) {
            val cookie = cookie()
            work.execute {
                try {
                    val source = server.resolve(src, cookie)
                    main.post { Player.load(id, source) }
                } catch (e: Exception) {
                    Log.error("Lecture refusée ($src) : ${e.message}")
                    val state = jsonOf("id" to id, "events" to org.json.JSONArray(listOf("error")),
                        "error" to jsonOf("code" to 4, "message" to (e.message ?: "")))
                    main.post { Player.send(state) }
                }
            }
        }

        @JavascriptInterface fun play() = main.post { Player.play() }.let {}
        @JavascriptInterface fun pause() = main.post { Player.pause() }.let {}
        @JavascriptInterface fun seek(time: Double) = main.post { Player.seek(time) }.let {}
        @JavascriptInterface fun setVolume(volume: Double) = main.post { Player.setVolume(volume.toFloat()) }.let {}
        @JavascriptInterface fun setRate(rate: Double) = main.post { Player.setRate(rate.toFloat()) }.let {}
        @JavascriptInterface fun detach() = main.post { Player.detach() }.let {}
        @JavascriptInterface fun setRect(left: Double, top: Double, width: Double, height: Double) = main.post { place(left, top, width, height) }.let {}
        // Retour depuis l'écran d'accueil de l'appli : on la met de côté, comme les autres applis télé.
        @JavascriptInterface fun exit() = main.post { moveTaskToBack(true) }.let {}
        @JavascriptInterface fun version() = BuildConfig.VERSION_NAME
    }

    // --- Télécommande ---

    private fun key(name: String) = web.evaluateJavascript("window.tvKeys && tvKeys.press(${JSONObject.quote(name)})", null)

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val name = when (event.keyCode) {
            KeyEvent.KEYCODE_CHANNEL_UP -> "PageUp"
            KeyEvent.KEYCODE_CHANNEL_DOWN -> "PageDown"
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> " "
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "ArrowRight"
            KeyEvent.KEYCODE_MEDIA_REWIND -> "ArrowLeft"
            KeyEvent.KEYCODE_MEDIA_STOP -> "Escape"
            KeyEvent.KEYCODE_INFO, KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_GUIDE -> "ContextMenu"
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                if (event.action == KeyEvent.ACTION_UP) {
                    web.evaluateJavascript("window.tvKeys ? tvKeys.back() : false") { handled ->
                        if (handled != "true") moveTaskToBack(true)
                    }
                }
                return true
            }
            else -> null
        }
        if (name != null) {
            if (event.action == KeyEvent.ACTION_DOWN) key(name)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    // --- Cycle de vie ---

    override fun onStop() {
        super.onStop()
        // Appli quittée : la connexion de l'abonnement est rendue.
        Player.pause()
        web.evaluateJavascript("window.tvKeys && tvKeys.hidden()", null)
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { server.stop() }
        runCatching { Player.stop() }
        runCatching { Player.exo.release() }
        web.destroy()
    }

    // --- Mise à jour : la dernière version publiée sur GitHub, installée par l'installeur d'Android ---

    private fun newer(a: String, b: String): Boolean {
        val x = a.trimStart('v').split(".").map { it.toIntOrNull() ?: 0 }
        val y = b.trimStart('v').split(".").map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
            if (d != 0) return d > 0
        }
        return false
    }

    private val french get() = Locale.getDefault().language == "fr"

    private fun checkUpdate() {
        try {
            val res = Http.request(RELEASES, headers = mapOf("Accept" to "application/vnd.github+json", "User-Agent" to "TV-Android"), timeoutMs = 10000)
            if (!res.ok) return
            val release = JSONObject(res.text())
            val tag = release.optString("tag_name")
            if (!newer(tag, BuildConfig.VERSION_NAME)) return
            val apk = release.optJSONArray("assets")?.objects()?.firstOrNull { it.optString("name").endsWith(".apk") } ?: return
            main.post {
                if (isFinishing) return@post
                AlertDialog.Builder(this)
                    .setTitle(if (french) "Mise à jour ${tag.trimStart('v')}" else "Update ${tag.trimStart('v')}")
                    .setMessage(if (french) "Une nouvelle version est disponible." else "A new version is available.")
                    .setPositiveButton(if (french) "Installer" else "Install") { _, _ -> work.execute { install(apk.getString("browser_download_url")) } }
                    .setNegativeButton(if (french) "Plus tard" else "Later", null)
                    .show()
            }
        } catch (e: Exception) {
            Log.warn("Mise à jour : ${e.message}")
        }
    }

    private fun install(url: String) {
        try {
            val dir = File(cacheDir, "updates").apply { mkdirs() }
            val file = File(dir, "tv.apk")
            val c = Http.open(url, headers = mapOf("User-Agent" to "TV-Android"), timeoutMs = 30000)
            try {
                if (c.responseCode !in 200..299) throw Exception("HTTP ${c.responseCode}")
                c.inputStream.use { input -> file.outputStream().use { input.copyTo(it) } }
            } finally {
                c.disconnect()
            }
            main.post {
                if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
                    // Première fois : Android demande d'autoriser l'appli à installer ses mises à jour.
                    startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                    return@post
                }
                val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
                startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        } catch (e: Exception) {
            Log.error("Mise à jour : ${e.message}")
        }
    }

    companion object {
        private const val RELEASES = "https://api.github.com/repos/xrousset78800/m3u_app_tv/releases/latest"
        private const val NanoHttpdTimeout = 30_000
    }
}
