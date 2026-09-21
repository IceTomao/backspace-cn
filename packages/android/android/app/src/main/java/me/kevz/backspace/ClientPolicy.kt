package me.kevz.backspace

import java.net.URI

object ClientPolicy {
    const val DEFAULT_SERVER = "https://chat.kevz.me:2096"
    fun server(value: String): String {
        val uri = URI(if (value.contains("://")) value else "https://$value")
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() &&
            uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
            (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) { "Invalid HTTPS server" }
        require(uri.port == -1 || uri.port in 1..65535) { "Invalid port" }
        return URI("https", null, uri.host.lowercase(), uri.port, null, null, null).toString()
    }
    fun shouldConnect(foreground: Boolean, background: Boolean, inCall: Boolean) =
        foreground || background || inCall
    fun bundledPage(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme == "https" && uri.host == "localhost" && uri.port == -1 && uri.rawUserInfo == null
    }.getOrDefault(false)
    fun microphoneAllowed(foreground: Boolean, granted: Boolean) = foreground && granted
    fun theme(value: String): String = value.takeIf { it in setOf("system", "light", "dark") } ?: "system"
    fun shouldNotify(selfId: String, authorId: String, isDm: Boolean, content: String, all: Boolean, muted: Boolean): Boolean =
        !muted && selfId.isNotEmpty() && selfId != authorId && (isDm || all || content.contains("<@$selfId>"))
}
