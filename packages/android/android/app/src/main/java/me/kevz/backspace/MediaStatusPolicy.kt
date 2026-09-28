package me.kevz.backspace

import org.json.JSONObject

internal class MediaSessionClock {
    private var playerPackage: String? = null
    private var startedAt = 0L

    fun start(packageName: String, now: Long): Long {
        if (playerPackage != packageName || startedAt == 0L) {
            playerPackage = packageName
            startedAt = now
        }
        return startedAt
    }

    fun reset() {
        playerPackage = null
        startedAt = 0L
    }
}

object MediaStatusPolicy {
    private val players = mapOf(
        "com.apple.android.music" to "Apple Music",
        "com.netease.cloudmusic" to "网易云音乐",
        "com.tencent.qqmusic" to "QQ 音乐",
        "com.spotify.music" to "Spotify"
    )

    fun playerName(packageName: String): String? = players[packageName.lowercase()]

    fun shouldCapture(enabled: Boolean, permissionGranted: Boolean, online: Boolean, showActivity: Boolean): Boolean =
        enabled && permissionGranted && online && showActivity

    fun activity(
        player: String,
        title: String,
        artist: String?,
        album: String?,
        paused: Boolean,
        startedAt: Long
    ): JSONObject {
        val state = listOfNotNull(artist?.takeIf(String::isNotBlank), album?.takeIf(String::isNotBlank))
            .toMutableList()
        if (paused) state.add("已暂停")
        return JSONObject()
            .put("type", "listening")
            .put("name", player)
            .put("details", title.take(128))
            .put("state", state.joinToString(" · ").take(128))
            .put("timestamps", JSONObject().put("start", startedAt))
    }
}
