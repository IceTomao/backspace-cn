package me.kevz.backspace

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.net.Uri
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteVideoTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.concurrent.TimeUnit
import kotlin.random.Random

private const val MEDIA_ACTIVITY_MIN_INTERVAL_MS = 3_200L
internal const val SOCKET_HEARTBEAT_MS = 60_000L
internal const val SOCKET_PONG_TIMEOUT_MS = 30_000L
internal fun reconnectDelay(attempt: Int, jitter: Double = Random.nextDouble()): Long =
    ((1000L shl attempt.coerceIn(0, 5)).coerceAtMost(30_000) * (0.8 + 0.2 * jitter.coerceIn(0.0, 1.0))).toLong()

class BackspaceRuntime internal constructor(
    private val context: Context,
    private val vault: ProfileVault = SecureVault(context),
    private val socketFactory: WebSocket.Factory? = null
) {
    companion object {
        @Volatile private var instance: BackspaceRuntime? = null
        @JvmStatic fun get(context: Context): BackspaceRuntime = instance ?: synchronized(this) {
            instance ?: BackspaceRuntime(context.applicationContext).also { instance = it }
        }
    }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).followRedirects(false).build()
    private val prefs = context.getSharedPreferences("client", Context.MODE_PRIVATE)
    var server: String = runCatching { ClientPolicy.server(prefs.getString("server", ClientPolicy.DEFAULT_SERVER)!!) }
        .getOrDefault(ClientPolicy.DEFAULT_SERVER)
        private set
    var foreground = false
        private set
    private var startedActivities = 0
    private var webVisible = true
    private var lastWebVisibilityCursors: String? = null
    private var networkAvailable = true
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastVoiceSnapshot: String? = null
    private var lastWebVoiceSnapshot: String? = null
    fun activityStarted() { startedActivities++; setForeground(true) }
    fun activityStopped() { startedActivities = (startedActivities - 1).coerceAtLeast(0); if (startedActivities == 0) setForeground(false) }
    fun setWebVisible(value: Boolean, cursors: JSONObject = JSONObject()) {
        webVisible = value
        if (!value) lastWebVisibilityCursors = null
        if (value && foreground && lastWebVisibilityCursors != cursors.toString()) {
            lastWebVisibilityCursors = cursors.toString()
            sync(cursors)
        }
    }
    fun notifyWebVisibility(value: Boolean) {
        webVisible = value
        if (!value) lastWebVisibilityCursors = null
        emit?.invoke("webVisibility", JSONObject().put("visible", value))
    }
    private fun canEmitWeb() = foreground && webVisible
    private fun emitWeb(name: String, value: JSONObject) { if (canEmitWeb()) emit?.invoke(name, value) }
    internal fun setNetworkAvailable(value: Boolean) {
        if (networkAvailable == value) return
        networkAvailable = value
        if (!value) sockets.values.forEach { it.pause() } else reconcileConnections()
    }
    private fun observeNetwork() {
        if (networkCallback != null || socketFactory != null) return
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val network = manager.activeNetwork
        networkAvailable = manager.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { handler.post { setNetworkAvailable(true) } }
            override fun onLost(network: Network) { handler.post {
                setNetworkAvailable(manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
            } }
        }
        manager.registerDefaultNetworkCallback(callback)
        networkCallback = callback
    }
    var background = prefs.getBoolean("background", false)
        private set
    var messageNotifications = prefs.getBoolean("messageNotifications", true)
        private set
    private var mediaStatusEnabled = prefs.getBoolean("mediaStatusEnabled", false)
    private var mediaSignature: String? = null
    private val mediaSessionClock = MediaSessionClock()
    private var mediaActivity: JSONObject? = null
    private var mediaArtworkId: String? = null
    private var mediaArtworkUrl: String? = null
    private var mediaArtworkPending = false
    private var mediaGeneration = 0
    private var mediaTrackStartedAt = 0L
    private var mediaPauseJob: Job? = null
    private var mediaPausedAt: Long? = null
    private var expiredPausedSignature: String? = null
    var emit: ((String, JSONObject) -> Unit)? = null
    var onTheme: (() -> Unit)? = null
    private var insets = JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0)
    fun insets(): JSONObject = JSONObject(insets.toString())
    fun setInsets(top: Float, right: Float, bottom: Float, left: Float) {
        val next = JSONObject().put("top", top).put("right", right).put("bottom", bottom).put("left", left)
        if (insets.toString() == next.toString()) return
        insets = next
        emit?.invoke("insets", next)
    }
    private val sockets = mutableMapOf<String, SocketSession>()
    private var room: Room? = null
    var watchingIdentity: String? = null
        private set
    private var viewerVisible = false
    private var streamSoundEnabled = true
    private var announcedWatcher: String? = null
    fun selectStream(identity: String) {
        require(foreground && !voiceIsDm && room != null) { "请先加入语音频道" }
        require(room!!.remoteParticipants.values.any { it.identity?.value == identity && it.trackPublications.values.any { p -> p.source == Track.Source.SCREEN_SHARE } }) { "直播已结束" }
        stopWatching()
        watchingIdentity = identity
        streamSoundEnabled = true
        emitVoice()
    }
    fun setViewerVisible(value: Boolean) {
        viewerVisible = value
        syncSubscriptions()
        announceWatching()
        emitVoice()
    }
    fun setStreamSound(enabled: Boolean) { streamSoundEnabled = enabled; syncSubscriptions(); emitVoice() }
    fun stopWatching(identity: String? = watchingIdentity) {
        if (identity != watchingIdentity) return
        viewerVisible = false
        announceWatching()
        watchingIdentity = null
        syncSubscriptions()
        emitVoice()
    }
    private fun announceWatching() {
        val target = watchingIdentity.takeIf { viewerVisible && foreground && voiceStatus == "connected" && streamPublication()?.muted == false }
        if (announcedWatcher == target) return
        val current = room ?: return
        val old = announcedWatcher
        announcedWatcher = target
        scope.launch {
            runCatching {
                old?.let { current.localParticipant.publishData(JSONObject().put("type", "stream_watch").put("target", it.substringBefore(':')).put("watching", false).toString().toByteArray(Charsets.UTF_8)) }
                target?.let { current.localParticipant.publishData(JSONObject().put("type", "stream_watch").put("target", it.substringBefore(':')).put("watching", true).toString().toByteArray(Charsets.UTF_8)) }
            }
        }
    }
    private fun streamPublication(): RemoteTrackPublication? = room?.remoteParticipants?.values
        ?.firstOrNull { it.identity?.value == watchingIdentity }?.trackPublications?.values
        ?.firstOrNull { it.source == Track.Source.SCREEN_SHARE } as? RemoteTrackPublication
    fun streamVideoTrack(): RemoteVideoTrack? = if (viewerVisible && foreground) streamPublication()?.takeIf { it.isDesired && !it.muted }?.track as? RemoteVideoTrack else null
    fun initializeVideoRenderer(renderer: livekit.org.webrtc.SurfaceViewRenderer) {
        (room ?: error("语音连接已结束")).initVideoRenderer(renderer)
    }
    private var roomEvents: Job? = null
    private var voiceGeneration = 0
    private var voiceOrigin = ""
    private var voiceChannel: String? = null
    private var voiceSpace = ""
    private var voiceIsDm = false
    private var federatedCallId: String? = null
    private var ringing = false
    private var ringTimeout: Job? = null
    private var serviceStopping = false
    private var switchingVoice = false
    private var callSignalling = false
    private var microphonePublishing = false
    private var voiceStatus = "disconnected"
    private var voiceError: String? = null
    var muted = false
        private set
    private var deafened = false
    private var forcedMute = false
    private var permissionMute = false
    private var forcedDeafen = false
    private var audioOptions = JSONObject()
    val inCall get() = voiceChannel != null
    private val seenMessages = LinkedHashSet<String>()
    private var pendingNotification: JSONObject? = null
    private var serviceReady: CompletableDeferred<Unit>? = null
    fun serviceStarted() { serviceReady?.complete(Unit) }
    fun restoreAudioIntent(data: JSONObject) {
        if (inCall) return
        val state = runCatching { JSONObject(data.optString("backspace-voice-settings", "{}")).optJSONObject("state") }.getOrNull()
        muted = state?.optBoolean("isMuted") ?: false
        deafened = state?.optBoolean("isDeafened") ?: false
        audioOptions = JSONObject().put("outputVolume", state?.optDouble("outputVolume", 100.0) ?: 100.0)
    }
    fun validateDownload(value: String) {
        val uri = URI(value)
        val origin = URI(uri.scheme, null, uri.host, uri.port, null, null, null).toString()
        require(uri.scheme == "https" && uri.rawUserInfo == null &&
            (origin == server || sockets.containsKey(origin)) && uri.path.startsWith("/api/uploads/")) {
            "仅支持从已连接服务器保存附件"
        }
    }
    suspend fun download(value: String, destination: Uri) = withContext(Dispatchers.IO) {
        validateDownload(value)
        require(destination.scheme == "content")
        http.newCall(Request.Builder().url(value).build()).execute().use { response ->
            check(response.isSuccessful) { "附件下载失败 (${response.code})" }
            val body = response.body ?: error("附件内容为空")
            context.contentResolver.openOutputStream(destination, "w")!!.use { output ->
                body.byteStream().use { input -> input.copyTo(output, 64 * 1024) }
            }
        }
    }
    fun backPressed() { emit?.invoke("back", JSONObject()) }

    fun settings(): JSONObject {
        val theme = ClientPolicy.theme(prefs.getString("theme", "system")!!)
        val dark = theme == "dark" || (theme == "system" &&
            context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
        return JSONObject().put("server", server).put("theme", theme).put("dark", dark)
            .put("background", background).put("messageNotifications", messageNotifications)
            .put("notificationsAllowed", context.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
            .put("mediaStatusEnabled", mediaStatusEnabled)
            .put("mediaAccess", MediaSessionListenerService.hasAccess(context))
            .put("mediaOnline", sockets.values.any { it.ready })
            .put("mediaActivityAllowed", sockets.values.any { it.ready && it.showActivity })
    }
    fun setMediaStatusEnabled(value: Boolean) {
        if (value && !MediaSessionListenerService.hasAccess(context)) {
            error("请先授予通知访问权限")
        }
        check(prefs.edit().putBoolean("mediaStatusEnabled", value).commit())
        mediaStatusEnabled = value
        if (!value) clearMediaActivity()
        refreshMediaCapture()
        emit?.invoke("preferences", settings())
    }
    fun shouldCaptureMedia(): Boolean = mediaStatusEnabled &&
        MediaStatusPolicy.shouldCapture(
            enabled = mediaStatusEnabled,
            permissionGranted = MediaSessionListenerService.hasAccess(context),
            online = sockets.values.any { it.ready },
            showActivity = sockets.values.any { it.ready && it.showActivity }
        )

    fun onMediaSessionChanged(snapshot: MediaSessionSnapshot?) {
        handler.post {
            if (!shouldCaptureMedia() || snapshot == null) {
                clearMediaActivity()
                return@post
            }
            applyMediaSnapshot(snapshot)
        }
    }

    private fun applyMediaSnapshot(snapshot: MediaSessionSnapshot) {
        val player = MediaStatusPolicy.playerName(snapshot.packageName) ?: run {
            clearMediaActivity()
            return
        }
        if (snapshot.title.isBlank()) {
            clearMediaActivity()
            return
        }
        val signature = listOf(snapshot.packageName, snapshot.title, snapshot.artist, snapshot.album).joinToString("\u0000")
        if (!snapshot.playing && signature == expiredPausedSignature) return
        if (signature != mediaSignature) {
            mediaGeneration++
            mediaPauseJob?.cancel()
            mediaPauseJob = null
            mediaPausedAt = null
            expiredPausedSignature = null
            deleteMediaArtwork(mediaArtworkId)
            mediaArtworkId = null
            mediaArtworkUrl = null
            mediaArtworkPending = false
            mediaSignature = signature
            mediaTrackStartedAt = mediaSessionClock.start(snapshot.packageName, System.currentTimeMillis())
        }
        if (snapshot.playing) expiredPausedSignature = null
        val next = MediaStatusPolicy.activity(
            player, snapshot.title, snapshot.artist, snapshot.album,
            paused = !snapshot.playing, startedAt = mediaTrackStartedAt
        )
        mediaActivity = next
        mediaArtworkUrl?.let { next.put("assets", JSONObject().put("largeImage", it).put("largeText", snapshot.title)) }

        if (signature != lastArtworkSignature && snapshot.artwork != null) {
            lastArtworkSignature = signature
            mediaArtworkPending = true
            val generation = mediaGeneration
            scope.launch {
                val session = sockets[""]?.takeIf { it.ready && it.showActivity }
                if (session == null) {
                    if (generation == mediaGeneration) {
                        mediaArtworkPending = false
                        lastArtworkSignature = null
                        mediaActivity?.let(::publishMediaActivity)
                    }
                    return@launch
                }
                val uploaded = uploadMediaArtwork(session, snapshot.artwork)
                if (uploaded == null) {
                    if (generation == mediaGeneration) {
                        mediaArtworkPending = false
                        lastArtworkSignature = null
                        mediaActivity?.let(::publishMediaActivity)
                    }
                    return@launch
                }
                if (generation != mediaGeneration || !shouldCaptureMedia()) {
                    deleteMediaArtwork(uploaded.first)
                    return@launch
                }
                mediaArtworkPending = false
                val previousId = mediaArtworkId
                mediaArtworkId = uploaded.first
                mediaArtworkUrl = uploaded.second
                mediaActivity?.put("assets", JSONObject().put("largeImage", uploaded.second)
                    .put("largeText", snapshot.title))
                mediaActivity?.let(::publishMediaActivity)
                deleteMediaArtwork(previousId)
            }
        } else if (!mediaArtworkPending) publishMediaActivity(next)
        if (snapshot.playing) {
            mediaPauseJob?.cancel()
            mediaPauseJob = null
            mediaPausedAt = null
        } else if (mediaPausedAt == null) {
            mediaPausedAt = System.currentTimeMillis()
            mediaPauseJob?.cancel()
            mediaPauseJob = scope.launch {
                delay(120_000)
                if (mediaSignature == signature) {
                    expiredPausedSignature = signature
                    clearMediaActivity()
                }
            }
        }
    }

    private var lastArtworkSignature: String? = null

    private fun publishMediaActivity(activity: JSONObject?) {
        val activities = JSONArray().apply { if (activity != null) put(activity) }
        sockets.values.filter { it.ready && it.showActivity }.forEach { session ->
            val serialized = activities.toString()
            sendMediaActivityUpdate(session, serialized,
                JSONObject().put("type", "activity_update").put("activities", activities).toString())
        }
    }

    private fun sendMediaActivityUpdate(session: SocketSession, state: String, payload: String) {
        if (!session.ready || !session.showActivity) return
        if (state == session.lastActivityUpdate) {
            clearPendingMediaActivity(session)
            return
        }
        val wait = MEDIA_ACTIVITY_MIN_INTERVAL_MS - (System.currentTimeMillis() - session.lastActivityUpdateAt)
        if (wait > 0) {
            session.pendingActivityState = state
            session.pendingActivityPayload = payload
            if (session.activityUpdateJob?.isActive != true) {
                session.activityUpdateJob = scope.launch {
                    delay(wait)
                    val pendingState = session.pendingActivityState
                    val pendingPayload = session.pendingActivityPayload
                    session.pendingActivityState = null
                    session.pendingActivityPayload = null
                    session.activityUpdateJob = null
                    if (pendingState != null && pendingPayload != null) {
                        sendMediaActivityUpdate(session, pendingState, pendingPayload)
                    }
                }
            }
            return
        }
        clearPendingMediaActivity(session)
        if (session.socket?.send(payload) == true) {
            session.lastActivityUpdate = state
            session.lastActivityUpdateAt = System.currentTimeMillis()
        }
    }

    private fun clearPendingMediaActivity(session: SocketSession) {
        session.activityUpdateJob?.cancel()
        session.activityUpdateJob = null
        session.pendingActivityState = null
        session.pendingActivityPayload = null
    }

    private fun clearMediaActivity() {
        mediaGeneration++
        mediaPauseJob?.cancel()
        mediaPauseJob = null
        if (mediaActivity != null || mediaArtworkId != null) publishMediaActivity(null)
        mediaActivity = null
        mediaSignature = null
        mediaSessionClock.reset()
        lastArtworkSignature = null
        mediaPausedAt = null
        mediaTrackStartedAt = 0L
        mediaArtworkUrl = null
        mediaArtworkPending = false
        deleteMediaArtwork(mediaArtworkId)
        mediaArtworkId = null
    }

    private fun refreshMediaCapture() {
        if (!shouldCaptureMedia()) clearMediaActivity()
        MediaSessionListenerService.refresh()
    }

    private suspend fun uploadMediaArtwork(session: SocketSession, artwork: Bitmap): Pair<String, String>? =
        withContext(Dispatchers.IO) {
            try {
                val scaled = if (artwork.width > 512 || artwork.height > 512) {
                    val factor = minOf(512f / artwork.width, 512f / artwork.height)
                    Bitmap.createScaledBitmap(artwork, (artwork.width * factor).toInt().coerceAtLeast(1),
                        (artwork.height * factor).toInt().coerceAtLeast(1), true)
                } else artwork
                val output = ByteArrayOutputStream()
                if (!scaled.compress(Bitmap.CompressFormat.JPEG, 82, output)) return@withContext null
                if (scaled !== artwork) scaled.recycle()
                if (output.size() > 256 * 1024) return@withContext null
                val body = JSONObject().put("image", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                    .toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url("$server/api/media-artwork")
                    .header("Authorization", "Bearer ${session.token}").post(body).build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@withContext null
                    val result = JSONObject(response.body?.string() ?: return@withContext null)
                    val id = result.getString("path").substringAfterLast('/')
                    id to "$server${result.getString("path")}"
                }
            } catch (_: Exception) {
                null
            }
        }

    private fun deleteMediaArtwork(id: String?) {
        if (id.isNullOrBlank()) return
        val session = sockets[""] ?: return
        scope.launch(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder().url("$server/api/media-artwork/$id")
                    .header("Authorization", "Bearer ${session.token}").delete().build()
                http.newCall(request).execute().close()
            }
        }
    }
    fun storage(): JSONObject = vault.read(server)
    fun putStorage(key: String, value: String?) {
        require(key.length in 1..200 && (value?.length ?: 0) <= 8_000_000)
        val data = storage()
        if (value == null) data.remove(key) else data.put(key, value)
        if (key == "backspace_token" && value == null) {
            background = false
            prefs.edit().putBoolean("background", false).commit()
            clearMediaActivity()
            hangup()
            sockets.keys.toList().forEach(::disconnect)
            clearNotifications()
            // Logout removes credentials for linked instances as well.
            data.keys().asSequence().filter { it.startsWith("backspace_instances") }.toList().forEach(data::remove)
        }
        vault.write(server, data)
    }
    fun switchServer(value: String) {
        val normalized = ClientPolicy.server(value)
        check(prefs.edit().putString("server", normalized).putBoolean("background", false).commit())
        background = false
        clearMediaActivity()
        hangup()
        sockets.keys.toList().forEach(::disconnect)
        clearNotifications()
        server = normalized
    }
    fun preferences(data: JSONObject) {
        if (data.has("theme")) {
            val theme = data.getString("theme")
            require(theme in setOf("system", "light", "dark"))
            check(prefs.edit().putString("theme", theme).commit())
        }
        if (data.has("background")) setBackground(data.getBoolean("background"))
        if (data.has("messageNotifications")) {
            val enabled = data.getBoolean("messageNotifications")
            check(prefs.edit().putBoolean("messageNotifications", enabled).commit())
            messageNotifications = enabled
        }
        onTheme?.invoke()
        emit?.invoke("preferences", settings())
    }
    fun setBackground(value: Boolean) {
        if (value) require(foreground) { "请在应用打开时开启后台在线" }
        val before = background
        background = value
        try {
            updateService()
            check(prefs.edit().putBoolean("background", value).commit())
            reconcileConnections()
            if (value) sockets.values.filter { it.ready }.forEach(::refreshMutedChannels)
        } catch (e: Exception) { background = before; throw e }
        emit?.invoke("preferences", settings())
    }
    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        if (!value) { viewerVisible = false; syncSubscriptions(); announceWatching() }
        if (value) {
            updateService()
            emitWeb("preferences", settings())
            emitVoice()
        }
        reconcileConnections()
    }
    fun setChannelMuted(channelId: String, muted: Boolean) {
        require(channelId.isNotBlank() && channelId.length <= 256)
        sockets.values.forEach { session ->
            session.pendingMuteUpdates[channelId] = muted
            session.mutedChannels?.let { if (muted) it.add(channelId) else it.remove(channelId) }
        }
    }
    private fun reconcileConnections() {
        for (session in sockets.values) {
            if (ClientPolicy.shouldConnect(foreground, background, inCall)) session.open() else session.pause()
        }
        refreshMediaCapture()
    }
    private fun updateService() {
        if (serviceStopping) return
        if (inCall || background) {
            ContextCompat.startForegroundService(context, Intent(context, BackspaceService::class.java))
        } else if (!switchingVoice) context.stopService(Intent(context, BackspaceService::class.java))
    }
    fun serviceDestroyed() {
        if (!foreground) {
            serviceStopping = true
            if (inCall) hangup()
            sockets.values.forEach { it.pause() }
            serviceStopping = false
        }
    }
    fun connect(origin: String, token: String) {
        observeNetwork()
        val key = if (origin.isBlank()) "" else ClientPolicy.server(origin)
        require(token.length in 1..16384)
        val current = sockets[key]
        if (current?.token == token) {
            if (ClientPolicy.shouldConnect(foreground, background, inCall)) current.open()
            return
        }
        disconnect(key)
        sockets[key] = SocketSession(key, token).also {
            if (ClientPolicy.shouldConnect(foreground, background, inCall)) it.open()
        }
    }
    fun disconnect(origin: String) {
        if (inCall && voiceOrigin == origin) hangup()
        sockets.remove(origin)?.let {
            if (it.ready && it.showActivity && mediaActivity != null) {
                it.socket?.send(JSONObject().put("type", "activity_update").put("activities", JSONArray()).toString())
            }
            it.incomingTimeout?.cancel()
            it.incoming = null
            it.pause()
        }
        refreshMediaCapture()
    }
    fun send(origin: String, event: JSONObject) {
        require(event.optString("type") != "auth" && event.toString().length <= 1_000_000)
        val session = sockets[origin] ?: error("尚未连接服务器")
        check(session.ready && session.socket?.send(event.toString()) == true) { "服务器连接已断开，请稍后重试" }
        if (event.optString("type") in setOf("dm_call_accept", "dm_call_reject", "dm_call_end")) {
            context.getSystemService(NotificationManager::class.java).cancel(20)
            session.incoming = null
            session.incomingTimeout?.cancel()
            emitIncoming(session)
        }
    }
    fun sync(cursors: JSONObject = JSONObject()) {
        if (!canEmitWeb()) return
        sockets.values.forEach { it.replay(cursors.optLong(it.origin, 0)); emitIncoming(it) }
        emitVoice(force = true)
        emitWeb("preferences", settings())
        pendingNotification?.let { emitWeb("notification", it) }
    }
    fun acknowledge(origin: String, value: Long) { sockets[origin]?.acknowledge(value) }
    fun resynchronize(origin: String) { sockets[origin]?.resynchronize() }
    fun notificationOpened(data: JSONObject) {
        pendingNotification = data
        emit?.invoke("notification", data)
    }
    fun ackNotification() { pendingNotification = null }
    private fun clearNotifications() {
        pendingNotification = null
        seenMessages.clear()
        context.getSystemService(NotificationManager::class.java).cancelAll()
        updateService()
    }

    private inner class SocketSession(val origin: String, val token: String) {
        var socket: WebSocket? = null
        var ready = false
        var userId = ""
        var userStatus = "online"
        var mutedChannels: MutableSet<String>? = null
        val pendingMuteUpdates = mutableMapOf<String, Boolean>()
        var showActivity = true
        var lastActivityUpdate: String? = null
        var lastActivityUpdateAt = 0L
        var pendingActivityState: String? = null
        var pendingActivityPayload: String? = null
        var activityUpdateJob: Job? = null
        var snapshot: JSONObject? = null
        var snapshotSequence = 0L
        private var latestSequence = 0L
        private var removedSequence = 0L
        val restrictions = mutableMapOf<String, JSONObject>()
        var incoming: JSONObject? = null
        var incomingTimeout: Job? = null
        val backlog = ArrayDeque<Pair<Long, JSONObject>>()
        private var reconnect: Job? = null
        private var heartbeat: Job? = null
        private var stableConnection: Job? = null
        private var pong: CompletableDeferred<Unit>? = null
        private var attempts = 0
        private var epoch = 0
        var overflow = false
        fun open() {
            if (!networkAvailable || socket != null || reconnect?.isActive == true) return
            val generation = ++epoch
            val url = (origin.ifEmpty { server }).replaceFirst("https://", "wss://") + "/ws"
            socket = (socketFactory ?: http).newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) { handler.post {
                    if (epoch != generation) { ws.close(1000, null); return@post }
                    ws.send(JSONObject().put("type", "auth").put("token", token).put("client", "mobile").toString())
                    heartbeat?.cancel()
                    heartbeat = scope.launch {
                        while (isActive) {
                            delay(SOCKET_HEARTBEAT_MS)
                            val response = CompletableDeferred<Unit>()
                            pong = response
                            if (!ws.send("""{"type":"ping"}""") || withTimeoutOrNull(SOCKET_PONG_TIMEOUT_MS) { response.await(); true } != true) {
                                ws.cancel()
                                break
                            }
                            pong = null
                        }
                    }
                } }
                override fun onMessage(ws: WebSocket, text: String) { handler.post {
                    if (epoch != generation || text.length > 12_000_000) return@post
                    try {
                        val event = JSONObject(text)
                        if (event.optString("type") == "pong") { pong?.complete(Unit); return@post }
                        if (!ready && event.optString("type") == "error" && event.optString("message") in
                            setOf("Invalid token", "Token has been revoked", "This account has been deleted")) {
                            pause()
                            if (inCall && voiceOrigin == origin) hangup()
                            sockets.remove(origin)
                            emit?.invoke("sessionExpired", JSONObject().put("origin", origin))
                            return@post
                        }
                        val eventSequence = ++latestSequence
                        if (event.optString("type") == "ready") {
                            ready = true
                            val user = event.getJSONObject("user")
                            userId = user.getString("id")
                            userStatus = user.optString("status", "online")
                            showActivity = user.optBoolean("showActivity", true)
                            clearPendingMediaActivity(this@SocketSession)
                            lastActivityUpdate = null
                            lastActivityUpdateAt = 0L
                            snapshot = event
                            snapshotSequence = eventSequence
                            removedSequence = 0L
                            backlog.clear()
                            overflow = false
                            stableConnection?.cancel()
                            stableConnection = scope.launch { delay(60_000); if (epoch == generation && ready) attempts = 0 }
                            emitWeb("socketStatus", JSONObject().put("origin", origin).put("connected", true))
                            emitWeb("preferences", settings())
                            if (background) refreshMutedChannels(this@SocketSession)
                            refreshMediaCapture()
                            if (showActivity && mediaActivity != null) publishMediaActivity(mediaActivity)
                            if (inCall && voiceOrigin == origin) {
                                if (!voiceIsDm) ws.send(JSONObject().put("type", "voice_join").put("channelId", voiceChannel).toString())
                                broadcastVoice()
                            }
                        } else {
                            if (event.optString("type") == "user_updated") {
                                val user = event.optJSONObject("user")
                                if (user != null && user.optString("id") == userId && user.has("showActivity")) {
                                    showActivity = user.optBoolean("showActivity")
                                    if (showActivity) {
                                        if (mediaActivity != null) publishMediaActivity(mediaActivity)
                                    } else {
                                        clearPendingMediaActivity(this@SocketSession)
                                        lastActivityUpdate = null
                                        clearMediaActivity()
                                    }
                                    refreshMediaCapture()
                                    emitWeb("preferences", settings())
                                }
                            }
                            if (backlog.size >= 512) { removedSequence = backlog.removeFirst().first; overflow = true }
                            backlog.addLast(eventSequence to event)
                        }
                        handleNativeEvent(this@SocketSession, event)
                        emitEvent(eventSequence, event)
                    } catch (_: Exception) { /* Ignore malformed frames; never log credentials or message text. */ }
                } }
                override fun onClosed(ws: WebSocket, code: Int, reason: String) { handler.post { closed(generation, code) } }
                override fun onFailure(ws: WebSocket, error: Throwable, response: Response?) { handler.post { closed(generation, 0) } }
            })
        }
        private fun closed(generation: Int, code: Int) {
            if (epoch != generation) return
            socket = null
            ready = false
            clearPendingMediaActivity(this)
            refreshMediaCapture()
            heartbeat?.cancel()
            stableConnection?.cancel()
            pong = null
            emitWeb("socketStatus", JSONObject().put("origin", origin).put("connected", false))
            emitWeb("preferences", settings())
            if (code in setOf(4001, 4003, 4004)) {
                if (inCall && voiceOrigin == origin) hangup()
                emit?.invoke("sessionExpired", JSONObject().put("origin", origin))
                return
            }
            if (sockets[origin] === this && ClientPolicy.shouldConnect(foreground, background, inCall)) {
                val wait = reconnectDelay(attempts)
                attempts++
                reconnect = scope.launch { delay(wait); reconnect = null; open() }
            }
        }
        fun pause() {
            epoch++
            reconnect?.cancel(); reconnect = null
            heartbeat?.cancel(); heartbeat = null
            stableConnection?.cancel(); stableConnection = null
            pong = null
            clearPendingMediaActivity(this)
            socket?.close(1000, null); socket = null
            ready = false
            emitWeb("socketStatus", JSONObject().put("origin", origin).put("connected", false))
            refreshMediaCapture()
        }
        fun acknowledge(value: Long) {
            if (value < snapshotSequence || value > latestSequence) return
            while (backlog.isNotEmpty() && backlog.first().first <= value) removedSequence = maxOf(removedSequence, backlog.removeFirst().first)
        }
        fun replay(cursor: Long) {
            if (!canEmitWeb()) return
            if (cursor < removedSequence) {
                resynchronize()
                return
            }
            snapshot?.takeIf { snapshotSequence > cursor }?.let { emitEvent(snapshotSequence, it) }
            backlog.filter { it.first > cursor }.forEach { (id, event) -> emitEvent(id, event) }
            emitWeb("socketStatus", JSONObject().put("origin", origin).put("connected", ready))
        }
        fun resynchronize() {
            pause()
            snapshot = null
            backlog.clear()
            removedSequence = 0
            if (ClientPolicy.shouldConnect(foreground, background, inCall)) open()
        }
        private fun emitEvent(id: Long, event: JSONObject) {
            emitWeb("socketEvent", JSONObject().put("origin", origin).put("sequence", id).put("event", event))
        }
    }

    private fun refreshMutedChannels(session: SocketSession) {
        scope.launch {
            val muted = runCatching { withContext(Dispatchers.IO) {
                val url = (session.origin.ifEmpty { server }) + "/api/users/@me/channel-notifications"
                http.newCall(Request.Builder().url(url).header("Authorization", "Bearer ${session.token}").build())
                    .execute().use { response ->
                        check(response.isSuccessful)
                        val values = JSONObject(response.body?.string() ?: "{}").getJSONArray("mutedChannelIds")
                        buildSet { for (index in 0 until values.length()) add(values.getString(index)) }
                    }
            } }.getOrNull()
            if (muted != null && sockets[session.origin] === session) {
                val current = muted.toMutableSet()
                session.pendingMuteUpdates.forEach { (channelId, isMuted) ->
                    if (isMuted) current.add(channelId) else current.remove(channelId)
                }
                session.pendingMuteUpdates.clear()
                session.mutedChannels = current
            }
        }
    }

    private fun handleNativeEvent(session: SocketSession, event: JSONObject) {
        val type = event.optString("type")
        if (type == "ready") session.restrictions.clear()
        if (type in setOf("ready", "space_voice_state")) {
            event.optJSONObject("spaceVoiceStates")?.let { states ->
                for (key in states.keys()) session.restrictions[key] = states.getJSONObject(key)
            }
        }
        if (type in setOf("voice_space_muted", "voice_permission_muted", "voice_space_deafened")) {
            val key = event.optString("spaceId") + ":" + event.optString("userId")
            val state = session.restrictions.getOrPut(key) { JSONObject() }
            when (type) {
                "voice_space_muted" -> state.put("spaceMuted", event.optBoolean("muted"))
                "voice_permission_muted" -> state.put("permissionMuted", event.optBoolean("muted"))
                "voice_space_deafened" -> state.put("spaceDeafened", event.optBoolean("deafened"))
            }
        }
        if (type == "presence_update" && event.optString("userId") == session.userId) session.userStatus = event.optString("status")
        if (type == "dm_call_incoming") {
            session.incoming = event
            if (inCall && voiceIsDm && voiceOrigin == session.origin && ringing &&
                event.optString("dmChannelId") == voiceChannel && event.optString("callerId") == session.userId) return
            if (!foreground) notifyIncoming(session, event)
            session.incomingTimeout?.cancel()
            session.incomingTimeout = scope.launch {
                delay(30000)
                if (session.incoming === event) {
                    session.incoming = null
                    context.getSystemService(NotificationManager::class.java).cancel(20)
                    runCatching { send(session.origin, JSONObject().put("type", "dm_call_reject")
                        .put("dmChannelId", event.opt("dmChannelId")).put("federatedCallId", event.opt("federatedCallId"))) }
                    emitIncoming(session)
                }
            }
            emitIncoming(session)
        }
        if (type in setOf("dm_call_ended", "dm_call_rejected", "dm_call_accepted")) {
            context.getSystemService(NotificationManager::class.java).cancel(20)
            session.incoming = null
            session.incomingTimeout?.cancel()
            emitIncoming(session)
        }
        if (type in setOf("message_created", "dm_message_created")) notifyMessage(session, event)
        if (!inCall || voiceOrigin != session.origin) return
        val sameCall = event.optString("dmChannelId") == voiceChannel ||
            (federatedCallId != null && event.optString("federatedCallId") == federatedCallId)
        if (voiceIsDm && type == "dm_call_accepted" && sameCall) {
            ringing = false
            ringTimeout?.cancel()
            applyAudio()
        }
        if (voiceIsDm && sameCall && (type in setOf("dm_call_ended", "dm_call_rejected") ||
            (type == "dm_call_undeliverable" && event.optBoolean("terminal")))) {
            hangup(false); return
        }
        if (type in setOf("ready", "space_voice_state")) { loadRestrictions(session); applyAudio() }
        if (type == "voice_disconnected" && event.optString("userId") == session.userId &&
            event.optString("channelId") == voiceChannel) { hangup(false); return }
        if (type == "member_banned" && event.optString("spaceId") == voiceSpace) { hangup(false); return }
        if (event.optString("userId") == session.userId) {
            when (type) {
                "voice_space_muted" -> if (event.optString("spaceId") == voiceSpace) forcedMute = event.optBoolean("muted")
                "voice_permission_muted" -> if (event.optString("spaceId") == voiceSpace) permissionMute = event.optBoolean("muted")
                "voice_space_deafened" -> if (event.optString("spaceId") == voiceSpace) forcedDeafen = event.optBoolean("deafened")
                "voice_moved" -> {
                    // A server move changes the room and therefore requires a new token,
                    // but never a second microphone session.
                    val data = JSONObject().put("channelId", event.getString("newChannelId"))
                        .put("origin", voiceOrigin).put("isDm", false).put("spaceId", voiceSpace)
                        .put("muted", muted).put("deafened", deafened)
                    scope.launch { runCatching { joinVoice(data, false) }.onFailure { failVoice("移动语音频道失败，请重新加入") } }
                    return
                }
            }
            applyAudio()
        }
    }
    private fun emitIncoming(session: SocketSession) {
        emitWeb("incoming", JSONObject().put("origin", session.origin).put("event", session.incoming ?: JSONObject.NULL))
    }
    private fun loadRestrictions(session: SocketSession) {
        val state = session.restrictions["$voiceSpace:${session.userId}"]
        forcedMute = state?.optBoolean("spaceMuted") ?: false
        forcedDeafen = state?.optBoolean("spaceDeafened") ?: false
        permissionMute = state?.optBoolean("permissionMuted") ?: false
    }
    private fun notifyMessage(session: SocketSession, event: JSONObject) {
        if (foreground || !background || !messageNotifications || session.userStatus == "dnd") return
        val message = event.optJSONObject("message") ?: return
        val channel = message.optString("channelId").ifEmpty { message.optString("dmChannelId") }
        val muted = session.mutedChannels ?: return
        if (channel.isBlank() || !ClientPolicy.shouldNotify(session.userId, message.optString("userId"), channel in muted)) return
        val id = session.origin + ":" + message.optString("id")
        if (!seenMessages.add(id)) return
        if (seenMessages.size > 512) seenMessages.remove(seenMessages.first())
        val data = JSONObject().put("origin", session.origin).put("channelId", channel).put("userId", session.userId)
        val name = message.optJSONObject("user")?.let { it.optString("displayName").ifEmpty { it.optString("username") } } ?: "新消息"
        val content = message.optString("content").ifEmpty { "收到附件" }.take(120)
        notify(id.hashCode(), "messages", name, content, data)
    }
    private fun notifyIncoming(session: SocketSession, event: JSONObject) {
        if (session.userStatus == "dnd") return
        notify(20, "calls", "语音来电", event.optString("callerName", "Backspace"),
            JSONObject().put("origin", session.origin).put("channelId", event.optString("dmChannelId"))
                .put("userId", session.userId).put("incoming", true))
    }
    private fun notify(id: Int, channel: String, title: String, text: String, data: JSONObject) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(channel,
            if (channel == "calls") "语音来电" else "聊天消息",
            if (channel == "calls") NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(context, MainActivity::class.java).putExtra("notification", data.toString())
        val pending = PendingIntent.getActivity(context, id, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, channel).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText(text).setContentIntent(pending).setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setTimeoutAfter(if (channel == "calls") 30000L else 86400000L)
            .setCategory(if (channel == "calls") NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE).build()
        runCatching { manager.notify(id, notification) }
    }

    suspend fun startCall(data: JSONObject) {
        check(!callSignalling && !(voiceIsDm && voiceChannel == data.optString("channelId"))) { "呼叫正在进行中" }
        callSignalling = true
        try {
            joinVoice(JSONObject(data.toString()).put("isDm", true).put("ringing", true))
            send(voiceOrigin, JSONObject().put("type", "dm_call_start").put("dmChannelId", voiceChannel))
            ringTimeout = scope.launch { delay(30000); if (ringing) hangup() }
        } catch (error: Exception) { if (error !is CancellationException) hangup(); throw error }
        finally { callSignalling = false }
    }
    suspend fun acceptCall(data: JSONObject) {
        check(!callSignalling) { "正在接听，请稍候" }
        callSignalling = true
        try {
            joinVoice(JSONObject(data.toString()).put("isDm", true))
            send(voiceOrigin, JSONObject().put("type", "dm_call_accept")
                .put("dmChannelId", data.opt("dmChannelId")).put("federatedCallId", data.opt("federatedCallId")))
        } catch (error: Exception) { if (error !is CancellationException) hangup(); throw error }
        finally { callSignalling = false }
    }
    suspend fun joinVoice(data: JSONObject, userInitiated: Boolean = true) {
        if (userInitiated) require(foreground) { "请打开应用后加入语音" }
        val channel = data.getString("channelId")
        val origin = data.optString("origin")
        val dm = data.optBoolean("isDm")
        require(channel.length in 1..200)
        val session = sockets[origin] ?: error("尚未登录服务器")
        if (voiceChannel == channel && voiceOrigin == origin && voiceStatus != "disconnected") return
        switchingVoice = true
        try { hangup(userInitiated) } finally { switchingVoice = false }
        voiceChannel = channel; voiceOrigin = origin; voiceIsDm = dm; voiceSpace = data.optString("spaceId")
        federatedCallId = data.optString("federatedCallId").takeIf { it.isNotEmpty() && it != "null" }
        ringing = data.optBoolean("ringing")
        voiceStatus = "connecting"; voiceError = null
        muted = data.optBoolean("muted"); deafened = data.optBoolean("deafened")
        loadRestrictions(session)
        val generation = ++voiceGeneration
        try {
            serviceReady = CompletableDeferred()
            updateService()
            withTimeout(5000) { serviceReady!!.await() }
            reconcileConnections()
            emitVoice()
            val incoming = if (data.isNull("livekitToken")) "" else data.optString("livekitToken")
            val response = if (incoming.isNotBlank()) {
                JSONObject().put("token", incoming).put("url", data.getString("livekitUrl"))
            } else withContext(Dispatchers.IO) {
                val body = JSONObject().put(if (dm) "dmChannelId" else "channelId", channel)
                val request = Request.Builder().url(origin.ifEmpty { server } + "/api/livekit/token")
                    .header("Authorization", "Bearer ${session.token}")
                    .post(body.toString().toRequestBody("application/json".toMediaType())).build()
                http.newCall(request).execute().use {
                    check(it.isSuccessful) { "获取语音权限失败 (${it.code})" }
                    JSONObject(it.body!!.string())
                }
            }
            if (generation != voiceGeneration) throw CancellationException("通话操作已取消")
            val url = response.getString("url")
            require(URI(url).scheme in setOf("wss", "https") && URI(url).rawUserInfo == null) { "语音服务器必须使用安全连接" }
            val next = LiveKit.create(context)
            room = next
            next.audioSwitchHandler?.audioDeviceChangeListener = { _, _ -> handler.post { emitVoice() } }
            next.setMicrophoneMute(muted || deafened || forcedMute || forcedDeafen || permissionMute || ringing)
            roomEvents = scope.launch {
                next.events.collect { event ->
                    if (room !== next) return@collect
                    when (event) {
                        is RoomEvent.Reconnecting -> voiceStatus = "reconnecting"
                        is RoomEvent.Reconnected, is RoomEvent.Connected -> voiceStatus = "connected"
                        is RoomEvent.Disconnected -> { failVoice("语音连接已断开，请重新加入"); return@collect }
                        is RoomEvent.ParticipantPermissionsChanged -> applyAudio()
                        else -> {}
                    }
                    syncSubscriptions()
                    announceWatching()
                    emitVoice()
                }
            }
            next.connect(url, response.getString("token"), ConnectOptions(autoSubscribe = false, audio = false, video = false))
            if (generation != voiceGeneration) throw CancellationException("通话操作已取消")
            if (!dm) send(origin, JSONObject().put("type", "voice_join").put("channelId", channel))
            val grant = next.localParticipant.permissions
            if (grant?.canPublish == true &&
                (grant.canPublishSources.isEmpty() || Track.Source.MICROPHONE in grant.canPublishSources) && !permissionMute) {
                check(next.localParticipant.setMicrophoneEnabled(true)) { "无法启用麦克风" }
            }
            voiceStatus = "connected"
            applyAudio()
            emitVoice()
        } catch (e: Exception) {
            if (generation == voiceGeneration) failVoice(e.message ?: "加入语音失败")
            throw e
        }
    }
    fun hangup(signal: Boolean = true) {
        stopWatching()
        announcedWatcher = null
        val oldChannel = voiceChannel
        if (signal && oldChannel != null) runCatching {
            send(voiceOrigin, if (voiceIsDm) JSONObject().put("type", "dm_call_end").put("dmChannelId", oldChannel)
                .put("federatedCallId", federatedCallId)
                else JSONObject().put("type", "voice_leave"))
        }
        voiceGeneration++
        ringTimeout?.cancel(); ringTimeout = null
        ringing = false
        voiceChannel = null
        roomEvents?.cancel(); roomEvents = null
        val old = room; room = null
        old?.audioSwitchHandler?.audioDeviceChangeListener = null
        old?.disconnect(); old?.release()
        voiceStatus = "disconnected"
        voiceError = null
        updateService()
        reconcileConnections()
        emitVoice()
    }
    private fun failVoice(message: String) {
        hangup()
        voiceError = message
        emitVoice()
    }
    fun toggleMuted() { muted = !muted; applyAudio(); updateService() }
    fun audio(data: JSONObject) {
        if (data.has("muted")) muted = data.getBoolean("muted")
        if (data.has("deafened")) deafened = data.getBoolean("deafened")
        audioOptions = data
        applyAudio()
    }
    private fun applyAudio() {
        val current = room
        current?.setMicrophoneMute(muted || deafened || forcedMute || forcedDeafen || permissionMute || ringing)
        val grant = current?.localParticipant?.permissions
        if (current != null && voiceStatus == "connected" && !microphonePublishing && !permissionMute &&
            !current.localParticipant.isMicrophoneEnabled && grant?.canPublish == true &&
            (grant.canPublishSources.isEmpty() || Track.Source.MICROPHONE in grant.canPublishSources)) {
            microphonePublishing = true
            scope.launch {
                try { if (room === current) current.localParticipant.setMicrophoneEnabled(true) }
                catch (_: Exception) { if (room === current) voiceError = "麦克风恢复失败，请重新加入语音" }
                finally { microphonePublishing = false; emitVoice() }
            }
        }
        syncSubscriptions()
        broadcastVoice()
        emitVoice()
    }
    private fun broadcastVoice() {
        if (!inCall) return
        runCatching { send(voiceOrigin, JSONObject().put("type", "voice_status")
            .put("isMuted", muted || deafened || forcedMute || permissionMute || forcedDeafen)
            .put("isDeafened", deafened || forcedDeafen).put("isCameraOn", false).put("isScreenSharing", false)) }
    }
    private fun syncSubscriptions() {
        val streamAvailable = streamPublication() != null
        room?.remoteParticipants?.values?.forEach { participant ->
            participant.trackPublications.values.forEach { publication ->
                if (publication is RemoteTrackPublication) {
                    val identity = participant.identity?.value ?: ""
                    val subscribe = StreamSubscriptionPolicy.subscribe(publication.source, identity, watchingIdentity,
                        viewerVisible && foreground && streamAvailable,
                        streamSoundEnabled && streamPublication()?.muted == false)
                    if (publication.isDesired != subscribe) publication.setSubscribed(subscribe)
                    val userId = participant.identity?.value?.substringBefore(":") ?: ""
                    val volume = audioOptions.optJSONObject("volumes")?.optDouble(userId, 100.0) ?: 100.0
                    val localMute = audioOptions.optJSONObject("mutes")?.optBoolean(userId) ?: false
                    (publication.track as? RemoteAudioTrack)?.setVolume(StreamSubscriptionPolicy.volume(
                        audioOptions.optDouble("outputVolume", 100.0), volume,
                        deafened || forcedDeafen || (publication.source == Track.Source.SCREEN_SHARE_AUDIO && (!subscribe || !streamSoundEnabled)), localMute))
                }
            }
        }
    }
    fun selectDevice(id: String) {
        val audio = room?.audioSwitchHandler ?: error("请先加入语音")
        if (id == "auto") audio.selectDevice(null)
        else audio.selectDevice(audio.availableAudioDevices.firstOrNull { it.name == id } ?: error("音频设备不可用"))
        emitVoice()
    }
    fun voiceSnapshot(): JSONObject {
        val participants = JSONArray()
        val streams = JSONArray()
        room?.let { current ->
            (listOf(current.localParticipant) + current.remoteParticipants.values).forEach {
                participants.put(JSONObject().put("identity", it.identity?.value ?: "")
                    .put("name", it.name ?: "").put("local", it === current.localParticipant)
                    .put("muted", !it.isMicrophoneEnabled).put("speaking", it.isSpeaking))
            }
            current.remoteParticipants.values.forEach { participant ->
                participant.trackPublications.values.filter { it.source == Track.Source.SCREEN_SHARE }.forEach { publication ->
                    streams.put(JSONObject().put("identity", participant.identity?.value ?: "").put("name", participant.name ?: "")
                        .put("videoSid", publication.sid)
                        .put("audioSid", participant.trackPublications.values.firstOrNull { it.source == Track.Source.SCREEN_SHARE_AUDIO }?.sid ?: JSONObject.NULL)
                        .put("muted", publication.muted))
                }
            }
        }
        val devices = JSONArray()
        room?.audioSwitchHandler?.availableAudioDevices?.forEach {
            devices.put(JSONObject().put("id", it.name).put("name", it.name))
        }
        return JSONObject().put("channelId", voiceChannel ?: JSONObject.NULL).put("origin", voiceOrigin).put("ringing", ringing)
            .put("isDm", voiceIsDm).put("status", voiceStatus).put("muted", muted).put("deafened", deafened)
            .put("error", voiceError ?: JSONObject.NULL).put("participants", participants).put("devices", devices)
            .put("deviceId", room?.audioSwitchHandler?.selectedAudioDevice?.name ?: JSONObject.NULL)
            .put("streams", streams).put("watchingIdentity", watchingIdentity ?: JSONObject.NULL)
            .put("streamSoundEnabled", streamSoundEnabled)
            .put("watchStatus", when {
                watchingIdentity == null -> "stopped"
                voiceStatus != "connected" -> voiceStatus
                !viewerVisible || !foreground -> "paused"
                streamPublication() == null -> "ended"
                streamPublication()?.subscriptionAllowed == false -> "unavailable"
                streamPublication()?.muted == true -> "paused"
                streamVideoTrack() == null -> "connecting"
                else -> "playing"
            })
    }
    private var lastObservedVideoTrack: RemoteVideoTrack? = null
    private fun emitVoice(force: Boolean = false) {
        val snapshot = voiceSnapshot()
        val serialized = snapshot.toString()
        val videoTrack = streamVideoTrack()
        if (force || serialized != lastVoiceSnapshot || videoTrack !== lastObservedVideoTrack) {
            lastVoiceSnapshot = serialized
            lastObservedVideoTrack = videoTrack
            voiceObservers.toList().forEach { it(snapshot) }
        }
        if (canEmitWeb() && (force || serialized != lastWebVoiceSnapshot)) {
            lastWebVoiceSnapshot = serialized
            emitWeb("voice", snapshot)
        }
    }
    private val voiceObservers = mutableSetOf<(JSONObject) -> Unit>()
    fun observeVoice(observer: (JSONObject) -> Unit): () -> Unit {
        voiceObservers.add(observer)
        observer(voiceSnapshot())
        return { voiceObservers.remove(observer) }
    }
}
