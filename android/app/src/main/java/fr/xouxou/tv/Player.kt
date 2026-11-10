package fr.xouxou.tv

import android.content.Context
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.text.Spanned
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player as MediaPlayer
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.decoder.DecoderInputBuffer
import androidx.media3.exoplayer.BaseRenderer
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.FormatHolder
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.extractor.text.CueDecoder
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max

// Ce que la page demande à lire, résolu par le serveur (accès vérifiés) : voir Server.resolve().
data class Source(
    val key: String,          // même film (et même piste audio) : le lecteur préparé est réutilisé
    val url: String,
    val hls: Boolean,
    val fallback: String? = null, // direct refusé en HLS : son flux brut
    val start: Double = 0.0,  // films : la page compte le temps depuis ce point
    val audio: Int = 0,
    val media: Boolean = false,
    val live: Boolean = false,
)

// Lecteur natif : ExoPlayer décode tout ce que la télé sait décoder (HEVC, AC3 selon le modèle…),
// sans la conversion ffmpeg de l'appli Windows. La page croit parler à un <video> (voir assets/tv/tv.js).
@OptIn(UnstableApi::class)
object Player {
    private val main = Handler(Looper.getMainLooper())
    lateinit var exo: ExoPlayer
        private set
    private lateinit var http: DefaultHttpDataSource.Factory

    // Envoi d'un état à la page (branché par MainActivity).
    var send: (JSONObject) -> Unit = {}
    var onVideoSize: (VideoSize) -> Unit = {}

    private var source: Source? = null
    private var loadId = 0 // numéro de la demande de la page : les états d'une ancienne lecture sont ignorés
    private var attached = false
    private var usedFallback = false
    private var everReady = false
    private var seekPending = false
    private var probeLatch: CountDownLatch? = null
    private var probeError: String? = null
    private var pendingAudio = -1 // piste audio demandée avant que les pistes du fichier soient connues

    fun init(context: Context) {
        http = DefaultHttpDataSource.Factory()
            .setUserAgent(Xtream.USER_AGENT)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(20000)
            .setReadTimeoutMs(20000)
        val renderers = object : DefaultRenderersFactory(context) {
            override fun buildTextRenderers(
                context: Context, output: TextOutput, outputLooper: Looper, extensionRendererMode: Int, out: ArrayList<Renderer>,
            ) {
                out.add(CueCollector)
            }
        }.setEnableDecoderFallback(true).setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
        val load = DefaultLoadControl.Builder()
            .setBackBuffer(60_000, true)
            .setBufferDurationsMs(15_000, 60_000, 1_500, 3_000)
            .build()
        exo = ExoPlayer.Builder(context, renderers).setLoadControl(load).build()
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
        exo.addListener(listener)
        main.post(tick)
    }

    // --- Préparation ---

    private fun mediaSource(url: String, hls: Boolean): MediaSource {
        val item = MediaItem.Builder().setUri(url).apply { if (hls) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()
        return if (hls) HlsMediaSource.Factory(http).setAllowChunklessPreparation(true).createMediaSource(item)
        else ProgressiveMediaSource.Factory(http).createMediaSource(item)
    }

    private fun prepare(s: Source) {
        cancelStop()
        source = s
        usedFallback = false
        everReady = false
        seekPending = false
        pendingAudio = -1
        CueCollector.reset(s.key)
        exo.stop()
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .clearOverrides().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
        exo.setMediaSource(mediaSource(s.url, s.hls))
        if (s.media) exo.seekTo((s.start * 1000).toLong())
        exo.prepare()
    }

    private fun prepared(s: Source) = source?.key == s.key && exo.playbackState != MediaPlayer.STATE_IDLE && exo.playerError == null

    // --- Demandes de la page (fil principal) ---

    fun load(id: Int, s: Source) {
        loadId = id
        attached = true
        if (s.media && prepared(s)) {
            cancelStop()
            source = s
            seekPending = true
            exo.seekTo((s.start * 1000).toLong())
        } else {
            prepare(s)
        }
        pendingAudio = s.audio
        selectAudio()
        exo.playWhenReady = true
        Log.log("Lecture : ${s.key}")
        push(listOf("loadstart"))
    }

    fun play() {
        if (attached) exo.playWhenReady = true
    }

    fun pause() {
        exo.playWhenReady = false
    }

    // Temps de la page (depuis le point de départ du film) -> position du fichier.
    fun seek(time: Double) {
        if (!attached) return
        seekPending = true
        exo.seekTo(((time + (source?.start ?: 0.0)) * 1000).toLong().coerceAtLeast(0))
    }

    fun setVolume(volume: Float) {
        exo.volume = volume.coerceIn(0f, 1f)
    }

    fun setRate(rate: Float) {
        exo.playbackParameters = PlaybackParameters(rate.coerceIn(0.25f, 4f))
    }

    // src retiré : la page va peut-être redonner le même film à un autre moment (déplacement).
    // On garde la connexion un instant ; sans nouvelle demande, on la rend (une seule par abonnement).
    private val stopLater = Runnable { stop() }

    fun detach() {
        attached = false
        exo.playWhenReady = false
        main.removeCallbacks(stopLater)
        if (source != null) main.postDelayed(stopLater, 1500)
    }

    private fun cancelStop() = main.removeCallbacks(stopLater)

    // La page va redonner ce fichier (analyse puis lecture) : on ne le rend pas entre-temps.
    fun keep() = cancelStop()

    fun stop() {
        cancelStop()
        attached = false
        source = null
        exo.stop()
        exo.clearMediaItems()
        CueCollector.reset(null)
    }

    private fun groups(type: Int) = exo.currentTracks.groups.filter { it.type == type }

    private fun selectAudio() {
        val audio = groups(C.TRACK_TYPE_AUDIO)
        if (audio.isEmpty() || pendingAudio < 0) return
        val group = audio.getOrNull(pendingAudio)
        pendingAudio = -1
        if (group == null) return
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0)).build()
    }

    // Piste de sous-titres (rang parmi celles du fichier) : lue en avance par CueCollector.
    fun selectText(index: Int) {
        val group = groups(C.TRACK_TYPE_TEXT).getOrNull(index)
        val params = exo.trackSelectionParameters.buildUpon()
        if (group == null) params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        else params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
        exo.trackSelectionParameters = params.build()
    }

    // --- Analyse d'un film (pour /api/media/probe) : appelée hors du fil principal ---

    fun probe(s: Source): JSONObject {
        val latch = CountDownLatch(1)
        main.post {
            probeLatch = latch
            probeError = null
            if (prepared(s) && exo.playbackState != MediaPlayer.STATE_BUFFERING) {
                latch.countDown()
            } else {
                attached = false
                exo.playWhenReady = false
                prepare(s)
            }
        }
        if (!latch.await(30, TimeUnit.SECONDS)) throw ApiError(504, "Le fichier ne répond pas")
        probeError?.let { throw ApiError(502, it) }
        return onMain { describe() }
    }

    fun <T> onMain(fn: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return fn()
        val latch = CountDownLatch(1)
        var result: Result<T>? = null
        main.post {
            result = runCatching(fn)
            latch.countDown()
        }
        latch.await(10, TimeUnit.SECONDS)
        return result?.getOrThrow() ?: throw ApiError(504, "Lecteur occupé")
    }

    private val AUDIO_CODECS = mapOf(
        MimeTypes.AUDIO_AC3 to "ac3", MimeTypes.AUDIO_E_AC3 to "eac3", MimeTypes.AUDIO_E_AC3_JOC to "eac3", MimeTypes.AUDIO_AC4 to "ac4",
        MimeTypes.AUDIO_DTS to "dts", MimeTypes.AUDIO_DTS_HD to "dts", MimeTypes.AUDIO_DTS_EXPRESS to "dts", MimeTypes.AUDIO_DTS_X to "dts",
        MimeTypes.AUDIO_AAC to "aac", MimeTypes.AUDIO_MPEG to "mp3", MimeTypes.AUDIO_MPEG_L2 to "mp2", MimeTypes.AUDIO_OPUS to "opus",
        MimeTypes.AUDIO_VORBIS to "vorbis", MimeTypes.AUDIO_FLAC to "flac", MimeTypes.AUDIO_TRUEHD to "truehd", MimeTypes.AUDIO_RAW to "pcm",
    )
    private val VIDEO_CODECS = mapOf(
        MimeTypes.VIDEO_H265 to "hevc", MimeTypes.VIDEO_H264 to "h264", MimeTypes.VIDEO_VP9 to "vp9", MimeTypes.VIDEO_AV1 to "av1",
        MimeTypes.VIDEO_MPEG2 to "mpeg2video", MimeTypes.VIDEO_MP4V to "mpeg4", MimeTypes.VIDEO_DOLBY_VISION to "hevc",
    )
    private val TEXT_CODECS = mapOf(
        MimeTypes.APPLICATION_SUBRIP to "subrip", MimeTypes.TEXT_SSA to "ass", MimeTypes.TEXT_VTT to "webvtt",
        MimeTypes.APPLICATION_TX3G to "mov_text", MimeTypes.APPLICATION_PGS to "hdmv_pgs_subtitle",
        MimeTypes.APPLICATION_DVBSUBS to "dvb_subtitle", MimeTypes.APPLICATION_VOBSUB to "dvd_subtitle",
    )
    private val TEXT_SUBTITLES = setOf("subrip", "ass", "webvtt", "mov_text")

    // Format d'origine : avec l'analyse des sous-titres à l'extraction, le type réel est dans `codecs`.
    private fun mime(f: Format) = if (f.sampleMimeType == MimeTypes.APPLICATION_MEDIA3_CUES) f.codecs ?: "" else f.sampleMimeType ?: ""

    private fun channels(n: Int) = when (n) {
        Format.NO_VALUE -> ""
        1 -> "mono"
        2 -> "stereo"
        6 -> "5.1"
        8 -> "7.1"
        else -> "$n ch"
    }

    private fun describe(): JSONObject {
        val video = groups(C.TRACK_TYPE_VIDEO).firstOrNull()?.getTrackFormat(0)
        val audio = groups(C.TRACK_TYPE_AUDIO).map { it.getTrackFormat(0) }
        val text = groups(C.TRACK_TYPE_TEXT).map { it.getTrackFormat(0) }
        val transfer = video?.colorInfo?.colorTransfer
        val subtitles = JSONArray()
        text.forEachIndexed { index, f ->
            val codec = TEXT_CODECS[mime(f)] ?: mime(f)
            if (codec !in TEXT_SUBTITLES) return@forEachIndexed
            val title = f.label ?: ""
            subtitles.put(jsonOf("index" to index, "codec" to codec, "lang" to (f.language ?: ""), "title" to title,
                "forced" to ((f.selectionFlags and C.SELECTION_FLAG_FORCED) != 0 || Regex("forc", RegexOption.IGNORE_CASE).containsMatchIn(title))))
        }
        return jsonOf(
            "duration" to (if (exo.duration == C.TIME_UNSET) 0.0 else exo.duration / 1000.0),
            "origin" to 0,
            "video" to video?.let { VIDEO_CODECS[it.sampleMimeType] ?: it.sampleMimeType },
            "fps" to video?.frameRate?.takeIf { it > 0 }?.let { Math.round(it * 1000) / 1000.0 },
            "tenBit" to ((video?.colorInfo?.lumaBitdepth ?: 8) >= 10 || video?.codecs?.startsWith("hvc1.2") == true || video?.codecs?.startsWith("hev1.2") == true),
            "hdr" to (transfer == C.COLOR_TRANSFER_ST2084 || transfer == C.COLOR_TRANSFER_HLG),
            "dolbyVision" to null, // la télé décode le Dolby Vision elle-même, ou prend l'image HEVC de repli
            "size" to if (video != null && video.width > 0) "${video.width}x${video.height}" else "",
            "audio" to JSONArray(audio.map { f ->
                jsonOf("codec" to (AUDIO_CODECS[f.sampleMimeType] ?: f.sampleMimeType ?: ""), "lang" to (f.language ?: ""),
                    "channels" to channels(f.channelCount), "title" to (f.label ?: ""))
            }),
            "allSubtitles" to JSONArray(text.map { f ->
                jsonOf("codec" to (TEXT_CODECS[mime(f)] ?: mime(f)), "lang" to (f.language ?: ""), "title" to (f.label ?: ""))
            }),
            "subtitles" to subtitles,
        )
    }

    // --- Sous-titres pour /api/media/subtitles (appelé hors du fil principal) ---

    fun subtitles(s: Source, track: Int, from: Int): JSONObject {
        val ready = onMain {
            val ok = source?.key == s.key && exo.playbackState != MediaPlayer.STATE_IDLE
            if (ok && CueCollector.track != track) {
                CueCollector.select(s.key, track)
                selectText(track)
            }
            ok
        }
        if (!ready) return jsonOf("ready" to false, "done" to false, "cues" to JSONArray())
        val (cues, done) = CueCollector.wait(s.key, track, s.start, from, 20_000)
        return jsonOf("ready" to true, "done" to done, "cues" to cues)
    }

    // --- État envoyé à la page ---

    private fun startOf() = source?.start ?: 0.0

    private fun state(events: List<String> = emptyList()): JSONObject {
        val live = exo.isCurrentMediaItemLive || source?.live == true && exo.duration == C.TIME_UNSET
        val start = startOf()
        val position = exo.currentPosition / 1000.0 - start
        val duration = if (live || exo.duration == C.TIME_UNSET) -1.0 else exo.duration / 1000.0 - start
        val ready = when (exo.playbackState) {
            MediaPlayer.STATE_READY -> 4
            MediaPlayer.STATE_BUFFERING -> if (everReady) 2 else if (exo.currentTracks.isEmpty) 0 else 1
            MediaPlayer.STATE_ENDED -> 4
            else -> 0
        }
        val size = exo.videoSize
        return jsonOf(
            "id" to loadId,
            "t" to max(0.0, position),
            "d" to duration,
            "live" to live,
            "paused" to !exo.playWhenReady,
            "ended" to (exo.playbackState == MediaPlayer.STATE_ENDED),
            "rs" to ready,
            "buf" to max(0.0, exo.bufferedPosition / 1000.0 - start),
            "w" to size.width,
            "h" to size.height,
            "events" to JSONArray(events),
        )
    }

    private fun push(events: List<String> = emptyList()) {
        if (!attached && events.isEmpty()) return
        send(state(events))
    }

    private val tick = object : Runnable {
        override fun run() {
            if (attached && exo.playbackState != MediaPlayer.STATE_IDLE) push()
            main.postDelayed(this, 250)
        }
    }

    private val listener = object : MediaPlayer.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            val events = mutableListOf<String>()
            when (state) {
                MediaPlayer.STATE_READY -> {
                    if (!everReady) {
                        everReady = true
                        events += listOf("durationchange", "loadedmetadata", "loadeddata", "canplay")
                    }
                    if (seekPending) {
                        seekPending = false
                        events += "seeked"
                    }
                    events += "canplaythrough"
                    if (exo.playWhenReady) events += "playing"
                    probeLatch?.countDown()
                    probeLatch = null
                }
                MediaPlayer.STATE_BUFFERING -> if (everReady) events += "waiting"
                MediaPlayer.STATE_ENDED -> {
                    if (seekPending) {
                        seekPending = false
                        events += "seeked"
                    }
                    if (source?.live != true) events += "ended"
                }
            }
            if (attached) push(events)
        }

        override fun onTracksChanged(tracks: Tracks) {
            selectAudio()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying && attached) push(listOf("playing"))
        }

        override fun onVideoSizeChanged(size: VideoSize) {
            onVideoSize(size)
            if (attached) push(listOf("resize"))
        }

        override fun onPlayerError(error: PlaybackException) {
            val s = source
            // Direct que le fournisseur refuse en HLS (souvent la 4K) : son flux brut, une fois.
            if (s?.fallback != null && !usedFallback && !everReady) {
                usedFallback = true
                Log.warn("Direct refusé en HLS (${error.errorCodeName}) : flux brut")
                exo.setMediaSource(mediaSource(s.fallback, false))
                exo.prepare()
                return
            }
            Log.error("Lecteur : ${error.errorCodeName} ${error.message ?: ""} (${s?.key})")
            probeLatch?.let {
                probeError = error.errorCodeName
                it.countDown()
            }
            probeLatch = null
            if (!attached) return
            // Codes de MediaError : 2 réseau, 3 décodage, 4 format non pris en charge.
            val code = when (error.errorCode) {
                in 2000..2999 -> 2
                in 4000..4999 -> if (error.errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
                    error.errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED) 4 else 3
                in 3000..3999 -> 4
                else -> 2
            }
            send(state(listOf("error")).put("error", jsonOf("code" to code, "message" to error.errorCodeName)))
        }
    }
}

// Lit la piste de sous-titres choisie en avance sur l'image (aussi loin que le lecteur a chargé),
// pour les donner à la page avec leurs horaires de début et de fin, comme ffmpeg pour l'appli Windows.
@OptIn(UnstableApi::class)
object CueCollector : BaseRenderer(C.TRACK_TYPE_TEXT) {
    class Cue(val start: Double, var end: Double, val text: String)

    private val lock = Object()
    private var key: String? = null
    var track = -1
        private set
    private val cues = ArrayList<Cue>()
    private var done = false
    private var open: Cue? = null // durée inconnue : finit au sous-titre suivant

    private val formatHolder = FormatHolder()
    private val buffer = DecoderInputBuffer(DecoderInputBuffer.BUFFER_REPLACEMENT_MODE_NORMAL)
    private val decoder = CueDecoder()
    private var offsetUs = 0L
    private var streamEnded = false

    fun reset(newKey: String?) = synchronized(lock) {
        key = newKey
        track = -1
        cues.clear()
        done = false
        open = null
        lock.notifyAll()
    }

    fun select(newKey: String, newTrack: Int) = synchronized(lock) {
        key = newKey
        track = newTrack
        cues.clear()
        done = false
        open = null
        lock.notifyAll()
    }

    // Les sous-titres qui finissent après `start`, triés, à partir du rang `from`.
    fun wait(forKey: String, forTrack: Int, start: Double, from: Int, timeoutMs: Long): Pair<JSONArray, Boolean> = synchronized(lock) {
        val until = System.currentTimeMillis() + timeoutMs
        while (true) {
            if (key != forKey || track != forTrack) return JSONArray() to false
            val list = cues.filter { it.end > start && it.end > it.start }.sortedBy { it.start }
            if (list.size > from || done) {
                val out = JSONArray()
                for (c in list.drop(from)) out.put(jsonOf("start" to c.start - start, "end" to c.end - start, "text" to c.text))
                return out to (done && list.size <= from + out.length())
            }
            val left = until - System.currentTimeMillis()
            if (left <= 0) return JSONArray() to false
            lock.wait(left)
        }
        @Suppress("UNREACHABLE_CODE")
        JSONArray() to false
    }

    private fun add(start: Double, end: Double?, text: String) = synchronized(lock) {
        open?.let { if (it.end == Double.MAX_VALUE) it.end = start }
        open = null
        if (text.isEmpty()) return
        // Relu après un déplacement : déjà connu.
        if (cues.any { Math.abs(it.start - start) < 0.01 && it.text == text }) return
        val cue = Cue(start, end ?: Double.MAX_VALUE, text)
        cues.add(cue)
        if (end == null) open = cue
        lock.notifyAll()
    }

    private fun finish() = synchronized(lock) {
        open?.let { if (it.end == Double.MAX_VALUE) cues.remove(it) }
        open = null
        done = true
        lock.notifyAll()
    }

    override fun getName() = "CueCollector"

    override fun supportsFormat(format: Format): Int =
        if (format.sampleMimeType == MimeTypes.APPLICATION_MEDIA3_CUES) RendererCapabilities.create(C.FORMAT_HANDLED)
        else RendererCapabilities.create(if (MimeTypes.isText(format.sampleMimeType)) C.FORMAT_UNSUPPORTED_SUBTYPE else C.FORMAT_UNSUPPORTED_TYPE)

    override fun onStreamChanged(formats: Array<out Format>, startPositionUs: Long, offsetUs: Long, mediaPeriodId: MediaSource.MediaPeriodId) {
        this.offsetUs = offsetUs
        streamEnded = false
    }

    override fun onPositionReset(positionUs: Long, joining: Boolean) {
        streamEnded = false
        synchronized(lock) { open = null }
    }

    override fun render(positionUs: Long, elapsedRealtimeUs: Long) {
        if (streamEnded) return
        while (true) {
            buffer.clear()
            val result = readSource(formatHolder, buffer, 0)
            if (result != C.RESULT_BUFFER_READ) return
            if (buffer.isEndOfStream) {
                streamEnded = true
                finish()
                return
            }
            buffer.flip()
            val data = buffer.data ?: continue
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            val decoded = runCatching { decoder.decode(buffer.timeUs, bytes, 0, bytes.size) }.getOrNull() ?: continue
            val start = (decoded.startTimeUs - offsetUs) / 1_000_000.0
            val end = if (decoded.durationUs == C.TIME_UNSET) null else start + decoded.durationUs / 1_000_000.0
            add(start, end, decoded.cues.mapNotNull { it.text?.let { t -> html(t) } }.filter { it.isNotBlank() }.joinToString("\n"))
        }
    }

    override fun isReady() = true
    override fun isEnded() = streamEnded

    // Italique, gras et souligné gardés en balises, comme dans le WebVTT de ffmpeg.
    private fun html(text: CharSequence): String {
        if (text !is Spanned) return text.toString().trim()
        val opens = HashMap<Int, StringBuilder>()
        val closes = HashMap<Int, StringBuilder>()
        for (span in text.getSpans(0, text.length, Any::class.java)) {
            val tag = when {
                span is StyleSpan && span.style == Typeface.ITALIC -> "i"
                span is StyleSpan && span.style == Typeface.BOLD -> "b"
                span is UnderlineSpan -> "u"
                else -> null
            } ?: continue
            opens.getOrPut(text.getSpanStart(span)) { StringBuilder() }.append("<$tag>")
            closes.getOrPut(text.getSpanEnd(span)) { StringBuilder() }.insert(0, "</$tag>")
        }
        val out = StringBuilder()
        for (i in 0..text.length) {
            closes[i]?.let { out.append(it) }
            opens[i]?.let { out.append(it) }
            if (i < text.length) out.append(text[i].let { if (it == '<') "&lt;" else if (it == '&') "&amp;" else it.toString() })
        }
        return out.toString().trim()
    }
}
