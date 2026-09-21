package me.kevz.backspace

import android.content.Context
import android.content.res.Configuration
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
        Dispatchers.setMain(UnconfinedTestDispatcher())
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
