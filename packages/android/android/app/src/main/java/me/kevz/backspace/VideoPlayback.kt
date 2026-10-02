package me.kevz.backspace

import java.net.URI

internal object VideoUrlPolicy {
    fun origin(value: String, allowed: Set<String>): String {
        require(value.length <= 4096)
        val uri = URI(value)
        val origin = URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString()
        val name = uri.path.removePrefix("/api/uploads/")
        require(uri.scheme == "https" && uri.rawUserInfo == null && origin in allowed &&
            uri.path.startsWith("/api/uploads/") && name.isNotBlank() && name !in setOf(".", "..") &&
            !name.contains('/') && !name.contains('\\') && uri.fragment == null) { "仅支持播放已连接服务器的附件" }
        return origin
    }
}

internal class VideoPlaybackSession(val url: String, val title: String, val mimetype: String, val origin: String) {
    var positionMs = 0L
    var muted = false
    var playOnStart = true
}

internal interface VideoEngine {
    val positionMs: Long
    fun prepare(positionMs: Long, play: Boolean, muted: Boolean)
    fun mute(muted: Boolean)
    fun release()
}

/** Buffers and decoders exist only while the playback page is visible. */
internal class VideoPlaybackController(val session: VideoPlaybackSession, private val create: () -> VideoEngine) {
    var engine: VideoEngine? = null
        private set
    fun start() {
        if (engine != null) return
        engine = create().also { it.prepare(session.positionMs, session.playOnStart, session.muted) }
        session.playOnStart = false
    }
    fun stop() {
        engine?.let { session.positionMs = it.positionMs.coerceAtLeast(0); it.release() }
        engine = null
        session.playOnStart = false
    }
    fun retry() { stop(); session.playOnStart = true; start() }
    fun toggleMute() { session.muted = !session.muted; engine?.mute(session.muted) }
}
