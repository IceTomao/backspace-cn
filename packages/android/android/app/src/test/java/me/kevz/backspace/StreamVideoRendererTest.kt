package me.kevz.backspace

import android.os.Looper
import livekit.org.webrtc.VideoFrame
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.lang.reflect.Proxy

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
@LooperMode(LooperMode.Mode.PAUSED)
class StreamVideoRendererTest {
    private fun frame(width: Int, height: Int, rotation: Int = 0): VideoFrame {
        // Frame metadata can be exercised without a decoder, JNI buffer or EGL context.
        val buffer = Proxy.newProxyInstance(VideoFrame.Buffer::class.java.classLoader,
            arrayOf(VideoFrame.Buffer::class.java)) { _, method, _ ->
            when (method.name) { "getWidth" -> width; "getHeight" -> height; else -> null }
        } as VideoFrame.Buffer
        return VideoFrame(buffer, rotation, 0L)
    }

    @Test fun metadataIsDeliveredOnTheUiThreadAndOnlyWhenGeometryChanges() {
        val renderer = StreamVideoRenderer(RuntimeEnvironment.getApplication())
        val sizes = mutableListOf<StreamVideoSize>()
        renderer.onVideoSize = sizes::add
        renderer.bindFrames(true)
        renderer.onFrame(frame(1920, 1080))
        renderer.onFrame(frame(1920, 1080))
        assertTrue(sizes.isEmpty())
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(StreamVideoSize(1920, 1080)), sizes)
        renderer.onFrame(frame(1920, 1080, 90))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamVideoSize(1080, 1920), sizes.last())
    }

    @Test fun detachedAndReplacedTracksCannotDeliverQueuedMetadata() {
        val renderer = StreamVideoRenderer(RuntimeEnvironment.getApplication())
        val sizes = mutableListOf<StreamVideoSize>()
        renderer.onVideoSize = sizes::add
        renderer.bindFrames(true)
        renderer.onFrame(frame(1920, 1080))
        renderer.bindFrames(false)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(sizes.isEmpty())
        renderer.bindFrames(true)
        renderer.onFrame(frame(1920, 1080))
        renderer.bindFrames(true)
        renderer.onFrame(frame(1080, 1920))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(listOf(StreamVideoSize(1080, 1920)), sizes)
        renderer.bindFrames(false)
        renderer.onFrame(frame(1920, 1080))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, sizes.size)
    }
}
