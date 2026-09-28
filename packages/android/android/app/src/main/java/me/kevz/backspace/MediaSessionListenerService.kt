package me.kevz.backspace

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.provider.Settings
import android.service.notification.NotificationListenerService

data class MediaSessionSnapshot(
    val packageName: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val playing: Boolean,
    val artwork: Bitmap?
)

internal data class CachedMediaMetadata(
    val title: String,
    val artist: String?,
    val album: String?,
    val artwork: Bitmap?
)

internal class MediaSessionMetadataCache {
    private var loaded = false
    private var metadata: CachedMediaMetadata? = null

    fun update(value: MediaMetadata?): CachedMediaMetadata? {
        metadata = value?.let {
            CachedMediaMetadata(
                title = it.getString(MediaMetadata.METADATA_KEY_TITLE)?.trim().orEmpty(),
                artist = it.getString(MediaMetadata.METADATA_KEY_ARTIST),
                album = it.getString(MediaMetadata.METADATA_KEY_ALBUM),
                artwork = it.getBitmap(MediaMetadata.METADATA_KEY_ART)
                    ?: it.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
            )
        }
        loaded = true
        return metadata
    }

    fun currentOrLoad(load: () -> MediaMetadata?): CachedMediaMetadata? {
        if (!loaded) update(load())
        return metadata
    }

    fun clear() {
        loaded = false
        metadata = null
    }
}

class MediaSessionListenerService : NotificationListenerService() {
    private var manager: MediaSessionManager? = null
    private var activeSessionsListener: MediaSessionManager.OnActiveSessionsChangedListener? = null
    private var controller: MediaController? = null
    private var controllerCallback: MediaController.Callback? = null
    private val metadataCache = MediaSessionMetadataCache()

    override fun onListenerConnected() {
        super.onListenerConnected()
        activeService = this
        manager = getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        refreshSessions()
    }

    override fun onListenerDisconnected() {
        stopTracking()
        activeService = null
        BackspaceRuntime.get(this).onMediaSessionChanged(null)
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        stopTracking()
        if (activeService === this) activeService = null
        BackspaceRuntime.get(this).onMediaSessionChanged(null)
        super.onDestroy()
    }

    private fun refreshSessions() {
        val runtime = BackspaceRuntime.get(this)
        if (!runtime.shouldCaptureMedia()) {
            stopTracking()
            runtime.onMediaSessionChanged(null)
            return
        }
        val currentManager = manager ?: run {
            stopTracking()
            runtime.onMediaSessionChanged(null)
            return
        }
        registerActiveSessionsListener(currentManager)
        val sessions = runCatching {
            currentManager.getActiveSessions(ComponentName(this, javaClass)).orEmpty()
        }.getOrDefault(emptyList())
        val supported = sessions.filter { MediaStatusPolicy.playerName(it.packageName) != null }
        val selected = supported.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            ?: supported.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PAUSED }
        if (selected == null) {
            untrackController()
            runtime.onMediaSessionChanged(null)
            return
        }
        val controllerChanged = controller?.sessionToken != selected.sessionToken
        if (controllerChanged) {
            untrackController()
            val callback = object : MediaController.Callback() {
                override fun onMetadataChanged(metadata: MediaMetadata?) {
                    if (controller?.sessionToken == selected.sessionToken) publishMetadata(selected, metadata)
                }
                override fun onPlaybackStateChanged(state: PlaybackState?) {
                    if (controller?.sessionToken == selected.sessionToken) publishCurrent(selected)
                }
                override fun onSessionDestroyed() {
                    if (controller?.sessionToken == selected.sessionToken) refreshSessions()
                }
            }
            controller = selected
            controllerCallback = callback
            runCatching { selected.registerCallback(callback) }
        }
        if (controllerChanged) publishMetadata(selected, selected.metadata) else publishCurrent(selected)
    }

    private fun registerActiveSessionsListener(currentManager: MediaSessionManager) {
        if (activeSessionsListener != null) return
        val listener = MediaSessionManager.OnActiveSessionsChangedListener { refreshSessions() }
        activeSessionsListener = listener
        if (runCatching {
                currentManager.addOnActiveSessionsChangedListener(listener, ComponentName(this, javaClass))
            }.isFailure) {
            if (activeSessionsListener === listener) activeSessionsListener = null
        }
    }

    private fun publishMetadata(session: MediaController, metadata: MediaMetadata?) {
        publish(session, metadataCache.update(metadata))
    }

    private fun publishCurrent(session: MediaController) {
        publish(session) { session.metadata }
    }

    private fun publish(session: MediaController, loadMetadata: () -> MediaMetadata?) {
        publish(session, metadataCache.currentOrLoad(loadMetadata))
    }

    private fun publish(session: MediaController, metadata: CachedMediaMetadata?) {
        val currentMetadata = metadata
        val state = session.playbackState?.state ?: PlaybackState.STATE_NONE
        if (currentMetadata == null || currentMetadata.title.isEmpty() ||
            state !in setOf(PlaybackState.STATE_PLAYING, PlaybackState.STATE_PAUSED)) {
            BackspaceRuntime.get(this).onMediaSessionChanged(null)
            return
        }
        BackspaceRuntime.get(this).onMediaSessionChanged(
            MediaSessionSnapshot(
                packageName = session.packageName,
                title = currentMetadata.title,
                artist = currentMetadata.artist,
                album = currentMetadata.album,
                playing = state == PlaybackState.STATE_PLAYING,
                artwork = currentMetadata.artwork
            )
        )
    }

    private fun untrackController() {
        val old = controller
        val callback = controllerCallback
        if (old != null && callback != null) runCatching { old.unregisterCallback(callback) }
        controller = null
        controllerCallback = null
        metadataCache.clear()
    }

    private fun unregisterActiveSessionsListener() {
        val listener = activeSessionsListener ?: return
        activeSessionsListener = null
        runCatching { manager?.removeOnActiveSessionsChangedListener(listener) }
    }

    private fun stopTracking() {
        unregisterActiveSessionsListener()
        untrackController()
    }

    companion object {
        @Volatile private var activeService: MediaSessionListenerService? = null

        fun hasAccess(context: Context): Boolean {
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                "enabled_notification_listeners"
            ) ?: return false
            val expected = ComponentName(context, MediaSessionListenerService::class.java)
            return enabled.split(':').any { ComponentName.unflattenFromString(it) == expected }
        }

        fun refresh() {
            activeService?.refreshSessions()
        }
    }
}
