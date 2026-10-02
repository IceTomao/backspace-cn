package me.kevz.backspace

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.os.Looper
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
@OptIn(ExperimentalCoroutinesApi::class)
class BackspaceRuntimeTest {
    private lateinit var context: Context
    private lateinit var runtime: BackspaceRuntime
    private lateinit var dispatcher: TestDispatcher
    private val created = mutableListOf<FakeSocket>()
    private val records = mutableMapOf<String, String>()
    private var failWrite = false
    private val vault = object : ProfileVault {
        override fun read(profile: String) = JSONObject(records[profile] ?: "{}")
        override fun write(profile: String, value: JSONObject) {
            check(!failWrite) { "storage full" }
            records[profile] = value.toString()
        }
    }
    private val factory = WebSocket.Factory { request, listener ->
        FakeSocket(request, listener).also { created.add(it) }
    }
    @Before fun setup() {
        dispatcher = UnconfinedTestDispatcher()
        Dispatchers.setMain(dispatcher)
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("client", 0).edit().clear().commit()
        runtime = BackspaceRuntime(context, vault, factory)
    }
    @After fun cleanup() {
        runtime.scope.cancel()
        Dispatchers.resetMain()
    }
    @Test fun connectsOncePausesAndReconnectsOnForeground() {
        runtime.setForeground(true)
        runtime.connect("", "test-session")
        runtime.connect("", "test-session")
        assertEquals(1, created.size)
        created[0].ready()
        assertTrue(created[0].sent.any { it.contains("\"auth\"") })
        runtime.setForeground(false)
        assertTrue(created[0].closed)
        runtime.setForeground(true)
        assertEquals(2, created.size)
    }
    @Test fun backgroundOptInAndOptOut() {
        assertFalse(runtime.background)
        runtime.setForeground(true)
        runtime.connect("", "session")
        runtime.setBackground(true)
        runtime.setForeground(false)
        assertFalse(created[0].closed)
        runtime.setBackground(false)
        assertTrue(created[0].closed)
    }
    @Test fun messageNotificationPreferenceDoesNotDisableBackgroundConnection() {
        runtime.setForeground(true)
        runtime.setBackground(true)
        runtime.preferences(JSONObject().put("messageNotifications", false))
        assertFalse(runtime.messageNotifications)
        assertTrue(runtime.background)
        assertFalse(runtime.settings().getBoolean("messageNotifications"))
        val restored = BackspaceRuntime(context, vault, factory)
        assertFalse(restored.messageNotifications)
        restored.scope.cancel()
    }
    @Test fun profilesAndSaveFailureAreIsolated() {
        runtime.putStorage("backspace_token", "first-session")
        runtime.switchServer("https://second.example")
        assertFalse(runtime.storage().has("backspace_token"))
        runtime.putStorage("backspace_token", "second-session")
        runtime.switchServer(ClientPolicy.DEFAULT_SERVER)
        assertEquals("first-session", runtime.storage().getString("backspace_token"))
        failWrite = true
        assertTrue(runCatching { runtime.putStorage("backspace_token", "unsaved") }.isFailure)
        assertEquals("first-session", runtime.storage().getString("backspace_token"))
    }
    @Test fun themeRestoresAndManualThemeOverridesSystem() {
        runtime.preferences(JSONObject().put("theme", "light"))
        val restored = BackspaceRuntime(context, vault, factory)
        assertEquals("light", restored.settings().getString("theme"))
        val config = Configuration(context.resources.configuration)
        config.uiMode = Configuration.UI_MODE_NIGHT_YES
        context.resources.updateConfiguration(config, context.resources.displayMetrics)
        assertFalse(restored.settings().getBoolean("dark"))
        restored.preferences(JSONObject().put("theme", "system"))
        assertTrue(restored.settings().getBoolean("dark"))
        restored.scope.cancel()
    }
    @Test fun mediaStatusPolicyRecognizesOnlySupportedPlayersAndPreservesTrackFields() {
        assertEquals("Apple Music", MediaStatusPolicy.playerName("com.apple.android.music"))
        assertEquals("网易云音乐", MediaStatusPolicy.playerName("com.netease.cloudmusic"))
        assertEquals("QQ 音乐", MediaStatusPolicy.playerName("com.tencent.qqmusic"))
        assertEquals("Spotify", MediaStatusPolicy.playerName("com.spotify.music"))
        assertNull(MediaStatusPolicy.playerName("com.example.player"))

        val playing = MediaStatusPolicy.activity("Spotify", "Track", "Artist", "Album", false, 1234L)
        assertEquals("listening", playing.getString("type"))
        assertEquals("Track", playing.getString("details"))
        assertEquals("Artist · Album", playing.getString("state"))
        assertEquals(1234L, playing.getJSONObject("timestamps").getLong("start"))

        val paused = MediaStatusPolicy.activity("Spotify", "Track", "Artist", null, true, 1234L)
        assertEquals("Artist · 已暂停", paused.getString("state"))
    }
    @Test fun mediaSessionClockContinuesAcrossTracksFromSamePlayer() {
        val clock = MediaSessionClock()
        val startedAt = clock.start("com.spotify.music", 1000L)
        val nextTrackStartedAt = clock.start("com.spotify.music", 2000L)
        val firstTrack = MediaStatusPolicy.activity("Spotify", "First track", "Artist", null, false, startedAt)
        val nextTrack = MediaStatusPolicy.activity("Spotify", "Next track", "Artist", null, true, nextTrackStartedAt)

        assertEquals(1000L, nextTrackStartedAt)
        assertEquals("First track", firstTrack.getString("details"))
        assertEquals("Next track", nextTrack.getString("details"))
        assertEquals(1000L, nextTrack.getJSONObject("timestamps").getLong("start"))
        assertEquals("Artist · 已暂停", nextTrack.getString("state"))
    }
    @Test fun mediaSessionClockRestartsWhenPlayerChangesOrSessionClears() {
        val clock = MediaSessionClock()
        clock.start("com.spotify.music", 1000L)
        val switchedPlayerAt = clock.start("com.tencent.qqmusic", 2000L)
        clock.reset()
        val restartedAfterClear = clock.start("com.tencent.qqmusic", 3000L)

        assertEquals(2000L, switchedPlayerAt)
        assertEquals(3000L, restartedAfterClear)
    }
    @Test fun mediaMetadataCacheLoadsOnlyOnceForPlaybackStateUpdates() {
        val cache = MediaSessionMetadataCache()
        var loads = 0
        val load = {
            loads++
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, "Track")
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "Artist")
                .build()
        }

        val first = cache.currentOrLoad(load)
        val second = cache.currentOrLoad(load)

        assertEquals(1, loads)
        assertSame(first, second)
        assertEquals("Track", second?.title)
    }
    @Test fun mediaMetadataCacheUpdatesTrackFieldsAndArtwork() {
        val cache = MediaSessionMetadataCache()
        val artwork = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val updated = cache.update(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, "New track")
                .putString(MediaMetadata.METADATA_KEY_ARTIST, "New artist")
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "New album")
                .putBitmap(MediaMetadata.METADATA_KEY_ART, artwork)
                .build()
        )

        assertEquals("New track", updated?.title)
        assertEquals("New artist", updated?.artist)
        assertEquals("New album", updated?.album)
        assertSame(artwork, updated?.artwork)
        artwork.recycle()
    }
    @Test fun mediaMetadataCacheClearsAndReloadsAfterSessionChange() {
        val cache = MediaSessionMetadataCache()
        cache.update(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, "Old track").build())
        cache.clear()
        var loads = 0

        val reloaded = cache.currentOrLoad {
            loads++
            MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, "New track").build()
        }

        assertEquals(1, loads)
        assertEquals("New track", reloaded?.title)
    }
    @Test fun mediaSharingIsDisabledByDefault() {
        assertFalse(runtime.settings().getBoolean("mediaStatusEnabled"))
    }
    @Test fun mediaCaptureRequiresOptInPermissionAnOnlineSessionAndActivityVisibility() {
        assertFalse(MediaStatusPolicy.shouldCapture(false, true, true, true))
        assertFalse(MediaStatusPolicy.shouldCapture(true, false, true, true))
        assertFalse(MediaStatusPolicy.shouldCapture(true, true, false, true))
        assertFalse(MediaStatusPolicy.shouldCapture(true, true, true, false))
        assertTrue(MediaStatusPolicy.shouldCapture(true, true, true, true))
    }
    @Test fun replaysOrderedEventsWithoutCreatingAnotherSocketAndCleansListener() {
        val ids = mutableListOf<Long>()
        runtime.emit = { name, value -> if (name == "socketEvent") ids.add(value.getLong("sequence")) }
        runtime.setForeground(true)
        runtime.connect("", "session")
        created[0].ready()
        created[0].event("""{"type":"presence_update","userId":"other","status":"online"}""")
        runtime.sync()
        assertEquals(listOf(1L, 2L, 1L, 2L), ids)
        assertEquals(1, created.size)
        runtime.emit = null
        created[0].event("""{"type":"presence_update","userId":"other","status":"offline"}""")
        assertEquals(4, ids.size)
    }
    @Test fun revokedSessionDoesNotReconnectOrRemainAuthorizedForDownloads() {
        runtime.setForeground(true)
        runtime.connect("https://peer.example", "session")
        created[0].event("""{"type":"error","message":"Token has been revoked"}""")
        assertTrue(created[0].closed)
        assertTrue(runCatching { runtime.validateDownload("https://peer.example/api/uploads/a.png") }.isFailure)
    }
    @Test fun backgroundQueuesEventsAndResumeOnlyReplaysUnconsumedEvents() {
        val events = mutableListOf<Long>()
        runtime.emit = { name, value -> if (name == "socketEvent") events.add(value.getLong("sequence")) }
        runtime.setForeground(true)
        runtime.setBackground(true)
        runtime.connect("", "session")
        created[0].ready()
        runtime.acknowledge("", 1)
        runtime.setForeground(false)
        created[0].event("""{"type":"presence_update","userId":"other","status":"offline"}""")
        assertEquals(listOf(1L), events)
        runtime.setForeground(true)
        runtime.setWebVisible(true, JSONObject().put("", 1))
        assertEquals(listOf(1L, 2L), events)
        runtime.acknowledge("", 2)
        runtime.sync(JSONObject().put("", 2))
        assertEquals(listOf(1L, 2L), events)
        assertEquals(1, created.size)
    }
    @Test fun acknowledgedTrafficDoesNotOverflowButColdWebViewResynchronizes() {
        runtime.setForeground(true)
        runtime.connect("", "session")
        created[0].ready()
        repeat(600) {
            created[0].event("""{"type":"presence_update","userId":"other","status":"online"}""")
            runtime.acknowledge("", it + 2L)
        }
        runtime.sync(JSONObject().put("", 601))
        assertEquals(1, created.size)
        runtime.sync()
        assertEquals(2, created.size)
        runtime.sync()
        assertEquals(2, created.size)
    }
    @Test fun lostBackgroundEventsTriggerOneFullResynchronization() {
        runtime.setForeground(true)
        runtime.setBackground(true)
        runtime.connect("", "session")
        created[0].ready()
        runtime.setWebVisible(false)
        repeat(513) { created[0].event("""{"type":"presence_update","userId":"other","status":"online"}""") }
        runtime.setWebVisible(true, JSONObject().put("", 1))
        assertEquals(2, created.size)
        runtime.sync(JSONObject().put("", 1))
        assertEquals(2, created.size)
    }
    @Test fun heartbeatWaitsSixtySecondsAndAllowsThirtySecondsForPong() {
        runtime.setForeground(true)
        runtime.connect("", "session")
        created[0].ready()
        dispatcher.scheduler.advanceTimeBy(59_999)
        dispatcher.scheduler.runCurrent()
        assertFalse(created[0].sent.any { it.contains("\"ping\"") })
        dispatcher.scheduler.advanceTimeBy(1)
        dispatcher.scheduler.runCurrent()
        assertEquals(1, created[0].sent.count { it.contains("\"ping\"") })
        dispatcher.scheduler.advanceTimeBy(29_999)
        dispatcher.scheduler.runCurrent()
        assertFalse(created[0].closed)
        dispatcher.scheduler.advanceTimeBy(1)
        dispatcher.scheduler.runCurrent()
        assertTrue(created[0].closed)
    }
    @Test fun pongKeepsConnectionAndOfflineStopsAttempts() {
        runtime.setForeground(true)
        runtime.connect("", "session")
        created[0].ready()
        dispatcher.scheduler.advanceTimeBy(60_000)
        dispatcher.scheduler.runCurrent()
        created[0].event("""{"type":"pong"}""")
        dispatcher.scheduler.advanceTimeBy(30_000)
        dispatcher.scheduler.runCurrent()
        assertFalse(created[0].closed)
        runtime.setNetworkAvailable(false)
        dispatcher.scheduler.advanceTimeBy(180_000)
        dispatcher.scheduler.runCurrent()
        assertEquals(1, created.size)
        runtime.setNetworkAvailable(true)
        assertEquals(2, created.size)
    }
    @Test fun nativeViewerKeepsAppForegroundWhileWebViewIsHidden() {
        var webEvents = 0
        runtime.emit = { name, _ -> if (name == "socketEvent") webEvents++ }
        runtime.activityStarted()
        runtime.connect("", "session")
        created[0].ready()
        runtime.activityStarted()
        runtime.notifyWebVisibility(false)
        runtime.activityStopped()
        assertTrue(runtime.foreground)
        assertFalse(created[0].closed)
        created[0].event("""{"type":"presence_update","userId":"other","status":"offline"}""")
        assertEquals(1, webEvents)
        runtime.activityStopped()
        assertFalse(runtime.foreground)
        assertTrue(created[0].closed)
    }
    inner class FakeSocket(private val req: Request, private val listener: WebSocketListener) : WebSocket {
        val sent = mutableListOf<String>()
        var closed = false
        override fun request() = req
        override fun queueSize() = 0L
        override fun send(text: String): Boolean { sent.add(text); return !closed }
        override fun send(bytes: ByteString) = !closed
        override fun cancel() { closed = true }
        override fun close(code: Int, reason: String?): Boolean { closed = true; return true }
        fun event(value: String) {
            listener.onMessage(this, value)
            shadowOf(Looper.getMainLooper()).idle()
        }
        fun ready() {
            listener.onOpen(this, Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(101).message("ok").build())
            event("""{"type":"ready","user":{"id":"me","status":"online"},"spaceVoiceStates":{},"spaces":[],"dmChannels":[]}""")
        }
    }
}
