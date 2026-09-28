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
import android.service.notification.StatusBarNotification

data class MediaSessionSnapshot(
    val packageName: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val playing: Boolean,
    val artwork: Bitmap?
)

class MediaSessionListenerService : NotificationListenerService() {
    private var manager: MediaSessionManager? = null
    private var activeSessionsListener: MediaSessionManager.OnActiveSessionsChangedListener? = null
    private var controller: MediaController? = null
    private var controllerCallback: MediaController.Callback? = null

    override fun onListenerConnected() {
        super.onListenerConnected()
        activeService = this
        manager = getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
        val listener = MediaSessionManager.OnActiveSessionsChangedListener { refreshSessions() }
        activeSessionsListener = listener
        runCatching { manager?.addOnActiveSessionsChangedListener(listener, ComponentName(this, javaClass)) }
        refreshSessions()
    }

    override fun onListenerDisconnected() {
        stopTracking()
        activeService = null
        BackspaceRuntime.get(this).onMediaSessionChanged(null)
        super.onListenerDisconnected()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        refreshSessions()
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        refreshSessions()
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
            untrackController()
            runtime.onMediaSessionChanged(null)
            return
        }
        val sessions = runCatching {
            manager?.getActiveSessions(ComponentName(this, javaClass)).orEmpty()
        }.getOrDefault(emptyList())
        val supported = sessions.filter { MediaStatusPolicy.playerName(it.packageName) != null }
        val selected = supported.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            ?: supported.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PAUSED }
        if (selected == null) {
            untrackController()
            runtime.onMediaSessionChanged(null)
            return
        }
        if (controller?.sessionToken != selected.sessionToken) {
            untrackController()
            val callback = object : MediaController.Callback() {
                override fun onMetadataChanged(metadata: MediaMetadata?) = publish(selected)
                override fun onPlaybackStateChanged(state: PlaybackState?) = publish(selected)
                override fun onSessionDestroyed() = refreshSessions()
            }
            controller = selected
            controllerCallback = callback
            runCatching { selected.registerCallback(callback) }
        }
        publish(selected)
    }

    private fun publish(session: MediaController) {
        val metadata = session.metadata
        val title = metadata?.getString(MediaMetadata.METADATA_KEY_TITLE)?.trim().orEmpty()
        val state = session.playbackState?.state ?: PlaybackState.STATE_NONE
        if (title.isEmpty() || state !in setOf(PlaybackState.STATE_PLAYING, PlaybackState.STATE_PAUSED)) {
            BackspaceRuntime.get(this).onMediaSessionChanged(null)
            return
        }
        val artwork = metadata?.getBitmap(MediaMetadata.METADATA_KEY_ART)
            ?: metadata?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)
        BackspaceRuntime.get(this).onMediaSessionChanged(
            MediaSessionSnapshot(
                packageName = session.packageName,
                title = title,
                artist = metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST),
                album = metadata?.getString(MediaMetadata.METADATA_KEY_ALBUM),
                playing = state == PlaybackState.STATE_PLAYING,
                artwork = artwork
            )
        )
    }

    private fun untrackController() {
        val old = controller
        val callback = controllerCallback
        if (old != null && callback != null) runCatching { old.unregisterCallback(callback) }
        controller = null
        controllerCallback = null
    }

    private fun stopTracking() {
        activeSessionsListener?.let { listener ->
            runCatching { manager?.removeOnActiveSessionsChangedListener(listener) }
        }
        activeSessionsListener = null
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
