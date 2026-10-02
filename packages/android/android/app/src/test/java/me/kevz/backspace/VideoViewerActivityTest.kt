package me.kevz.backspace

import android.content.res.Configuration
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
@OptIn(ExperimentalCoroutinesApi::class)
class VideoViewerActivityTest {
    private lateinit var runtime: BackspaceRuntime
    private var activity: ActivityController<VideoViewerActivity>? = null
    private val engines = mutableListOf<FakeVideoEngine>()
    @Before fun setup() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        runtime = BackspaceRuntime(RuntimeEnvironment.getApplication(), object : ProfileVault {
            override fun read(profile: String) = JSONObject()
            override fun write(profile: String, value: JSONObject) {}
        })
        runtime.setForeground(true)
        VideoViewerActivity.runtimeProvider = { runtime }
        VideoViewerActivity.engineFactory = { _, _ -> FakeVideoEngine().also(engines::add) }
    }
    @After fun cleanup() {
        activity?.pause()?.stop()?.destroy()
        runtime.scope.cancel()
        VideoViewerActivity.runtimeProvider = { BackspaceRuntime.get(it) }
        VideoViewerActivity.engineFactory = null
        Dispatchers.resetMain()
    }
    private fun launch(): ActivityController<VideoViewerActivity> {
        runtime.openVideo("${runtime.server}/api/uploads/clip.mp4", "clip.mp4", "video/mp4")
        return Robolectric.buildActivity(VideoViewerActivity::class.java).create().start().resume().visible().also { activity = it }
    }
    @Test fun nativeBackFinishesOnlyThePlayerAndReleasesResources() {
        val page = launch()
        assertTrue(runtime.foreground)
        page.get().onBackPressedDispatcher.onBackPressed()
        assertTrue(page.get().isFinishing)
        page.pause().stop().destroy(); activity = null
        assertEquals(1, engines.single().releases)
        assertNull(runtime.videoPlayback)
    }
    @Test fun backgroundAndRotationPreserveTheSessionWithoutAutoplayOnReturn() {
        val page = launch()
        engines.single().positionMs = 3200
        page.get().onConfigurationChanged(Configuration().apply { orientation = Configuration.ORIENTATION_LANDSCAPE })
        assertEquals(1, engines.size)
        page.pause().stop()
        assertEquals(3200L, runtime.videoPlayback?.positionMs)
        assertFalse(runtime.foreground)
        page.start().resume()
        assertTrue(runtime.foreground)
        assertEquals(3200L, engines.last().preparedPosition); assertFalse(engines.last().play)
    }
    @Test fun switchingServerOrLoggingOutClosesThePlayerAndOldCleanupDoesNotClearANewSession() {
        val page = launch()
        runtime.switchServer("https://other.example")
        assertTrue(page.get().isFinishing); assertNull(runtime.videoPlayback)
        assertEquals(1, engines.single().releases)
        runtime.setWebVisible(true)
        runtime.openVideo("${runtime.server}/api/uploads/next.mp4", "next", "video/mp4")
        val next = runtime.videoPlayback
        page.pause().stop().destroy(); activity = null
        assertSame(next, runtime.videoPlayback)
        runtime.putStorage("backspace_token", null)
        assertNull(runtime.videoPlayback)
    }
    @Test fun missingSessionAndHiddenWebViewCannotStartPlayback() {
        val page = Robolectric.buildActivity(VideoViewerActivity::class.java).create()
        assertTrue(page.get().isFinishing); page.destroy()
        runtime.setWebVisible(false)
        assertTrue(runCatching { runtime.openVideo("${runtime.server}/api/uploads/clip.mp4", "clip", "video/mp4") }.isFailure)
        assertTrue(engines.isEmpty())
    }
}
