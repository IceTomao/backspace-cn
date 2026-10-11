package me.kevz.backspace

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.ColorDrawable
import android.graphics.Paint
import android.os.Bundle
import android.os.Looper
import android.media.AudioManager
import android.provider.Settings
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import io.livekit.android.room.track.RemoteVideoTrack
import livekit.org.webrtc.SurfaceViewRenderer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Implementation
import org.robolectric.shadows.ShadowAudioManager
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
@LooperMode(LooperMode.Mode.PAUSED)
class StreamViewerActivityTest {
    private lateinit var session: FakeStreamSession
    private val outputs = mutableListOf<FakeStreamRenderer>()
    private var controller: ActivityController<StreamViewerActivity>? = null

    @Before fun setup() {
        session = FakeStreamSession()
        StreamViewerActivity.sessionFactory = { session }
        StreamViewerActivity.rendererFactory = { FakeStreamRenderer(it).also(outputs::add) }
    }

    @After fun cleanup() {
        controller?.pause()?.stop()?.destroy()
        StreamViewerActivity.sessionFactory = { RuntimeStreamViewerSession(it) }
        StreamViewerActivity.rendererFactory = { StreamVideoRenderer(it) }
    }

    private fun launch(saved: Bundle? = null): StreamViewerActivity {
        val intent = Intent(RuntimeEnvironment.getApplication(), StreamViewerActivity::class.java).putExtra("identity", "alice")
        val page = Robolectric.buildActivity(StreamViewerActivity::class.java, intent)
        controller = page
        return page.create(saved).start().resume().visible().get()
    }
    private fun StreamViewerActivity.click(id: Int) { findViewById<View>(id).performClick() }
    private fun StreamViewerActivity.view(id: Int) = findViewById<View>(id)
    private fun advance(seconds: Long) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(seconds)) }
    private fun StreamViewerActivity.motion(action: Int, x: Float, y: Float) {
        val target = view(R.id.stream_gestures)
        val event = MotionEvent.obtain(0, 0, action, x * target.width, y * target.height, 0)
        try { target.dispatchTouchEvent(event) } finally { event.recycle() }
    }
    private fun StreamViewerActivity.swipe(x: Float, from: Float, to: Float) {
        motion(MotionEvent.ACTION_DOWN, x, from)
        motion(MotionEvent.ACTION_MOVE, x, to)
        motion(MotionEvent.ACTION_UP, x, to)
    }
    private fun StreamViewerActivity.layout(width: Int, height: Int) {
        val root = findViewById<View>(android.R.id.content)
        fun forceLayout(view: View) {
            view.forceLayout()
            if (view is android.view.ViewGroup) for (index in 0 until view.childCount) forceLayout(view.getChildAt(index))
        }
        repeat(3) {
            // Manual offscreen rendering has no ViewRoot traversal to service requestLayout().
            forceLayout(root)
            root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, width, height)
        }
    }

    @Test fun fullscreenFollowsContentAndFirstBackRestoresTheOriginalPolicy() {
        val activity = launch()
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        activity.onVideoSizeChanged(StreamVideoSize(1920, 1080))
        activity.click(R.id.stream_fullscreen_button)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, activity.requestedOrientation)
        assertEquals(activity.getString(R.string.stream_exit_fullscreen), activity.view(R.id.stream_fullscreen_button).contentDescription)
        activity.onVideoSizeChanged(StreamVideoSize(1080, 1920))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, activity.requestedOrientation)
        activity.onBackPressedDispatcher.onBackPressed()
        assertFalse(activity.isFinishing)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
        assertEquals(0, session.stopsWatching)
        activity.onBackPressedDispatcher.onBackPressed()
        assertTrue(activity.isFinishing)
        controller!!.pause().stop().destroy(); controller = null
        assertEquals(1, session.stopsWatching)
        assertEquals(1, outputs.single().releases)
        assertNull(session.observer)
    }

    @Test fun unknownAndSquareContentDoNotForceOrientationAndLateDimensionsDo() {
        val activity = launch()
        activity.click(R.id.stream_fullscreen_button)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
        activity.onVideoSizeChanged(StreamVideoSize(1000, 1000))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
        activity.onVideoSizeChanged(StreamVideoSize(1920, 1080))
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, activity.requestedOrientation)
    }

    @Test fun controlsHideAfterThreeSecondsAndAudioActionsResetTheTimer() {
        val activity = launch()
        activity.click(R.id.stream_fullscreen_button)
        advance(2)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        activity.click(R.id.stream_sound_button)
        assertFalse(session.snapshot.getBoolean("streamSoundEnabled"))
        advance(2)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        advance(1)
        assertEquals(View.INVISIBLE, activity.view(R.id.stream_footer).visibility)
        activity.click(R.id.stream_viewport)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        activity.click(R.id.stream_mic_button)
        assertTrue(session.snapshot.getBoolean("muted"))
        assertEquals(activity.getString(R.string.stream_unmute), activity.view(R.id.stream_mic_button).contentDescription)
        advance(3)
        activity.click(R.id.stream_viewport)
        activity.click(R.id.stream_fullscreen_button)
        advance(4)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
    }

    @Test fun errorsRemainVisibleAndBackgroundResumePreservesTheSession() {
        val activity = launch()
        activity.click(R.id.stream_fullscreen_button)
        for (status in listOf("connecting", "reconnecting", "paused", "unavailable", "ended")) {
            session.emit(status)
            advance(4)
            assertEquals(View.VISIBLE, activity.view(R.id.stream_header).visibility)
            assertEquals(View.VISIBLE, activity.view(R.id.stream_message).visibility)
            assertEquals(0, activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        session.emit("playing")
        assertEquals(View.GONE, activity.view(R.id.stream_message).visibility)
        assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
        controller!!.pause().stop()
        assertFalse(session.visible)
        assertEquals(0, session.stopsWatching)
        advance(4)
        controller!!.start().resume()
        assertTrue(session.visible)
        assertEquals(1, outputs.size)
        assertEquals(1, session.initializations)
        assertEquals(2, session.starts)
        assertEquals(1, session.stops)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        session.inCall = false
        session.emit("disconnected")
        assertTrue(activity.isFinishing)
    }

    @Test fun rotationKeepsRendererAndFullScreenGeometryDoesNotReserveChromeSpace() {
        val activity = launch()
        activity.layout(393, 800)
        activity.onVideoSizeChanged(StreamVideoSize(1920, 1080))
        activity.layout(393, 800)
        val viewport = activity.view(R.id.stream_viewport)
        val fitted = StreamVideoSize(1920, 1080).fit(viewport.width, viewport.height)
        assertEquals(fitted.width, outputs.single().layoutParams.width)
        assertEquals(fitted.height, outputs.single().layoutParams.height)
        assertEquals(fitted.width, outputs.single().width)
        assertEquals(fitted.height, outputs.single().height)
        assertTrue((viewport.layoutParams as FrameLayout.LayoutParams).topMargin > 0)
        activity.click(R.id.stream_fullscreen_button)
        val config = Configuration(activity.resources.configuration).apply { orientation = Configuration.ORIENTATION_LANDSCAPE }
        controller!!.configurationChange(config)
        activity.layout(800, 393)
        val margins = viewport.layoutParams as FrameLayout.LayoutParams
        assertEquals(0, margins.topMargin)
        assertEquals(0, margins.bottomMargin)
        assertEquals(1, outputs.size)
        assertEquals(1, session.initializations)
        assertEquals(0, session.stopsWatching)
        assertEquals(0, session.stops)
    }

    @Test fun recreationRestoresFullscreenAndItsExitOrientation() {
        var activity = launch()
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        activity.onVideoSizeChanged(StreamVideoSize(1920, 1080))
        activity.click(R.id.stream_fullscreen_button)
        controller!!.recreate()
        activity = controller!!.get()
        assertEquals(0, session.stopsWatching)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, activity.requestedOrientation)
        activity.onBackPressedDispatcher.onBackPressed()
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, activity.requestedOrientation)
        assertFalse(activity.isFinishing)
    }

    @Test fun touchExplorationKeepsControlsAvailable() {
        val activity = launch()
        shadowOf(activity.getSystemService(AccessibilityManager::class.java)).setTouchExplorationEnabled(true)
        activity.click(R.id.stream_fullscreen_button)
        advance(5)
        activity.click(R.id.stream_viewport)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
    }

    @Test fun themeTracksSettingsAndFullscreenKeepsReadableDarkChrome() {
        val activity = launch()
        val title = activity.findViewById<TextView>(R.id.stream_title)
        assertEquals(Color.rgb(27, 31, 39), title.currentTextColor)
        session.dark = true; session.emit("playing")
        assertEquals(Color.rgb(239, 239, 239), title.currentTextColor)
        session.dark = false; session.emit("playing")
        activity.click(R.id.stream_fullscreen_button)
        assertEquals(Color.rgb(239, 239, 239), title.currentTextColor)
        activity.click(R.id.stream_fullscreen_button)
        assertEquals(Color.rgb(27, 31, 39), title.currentTextColor)
        assertEquals(Color.BLACK, (activity.view(R.id.stream_viewport).background as ColorDrawable).color)
        assertEquals("Alice", title.text.toString())
    }

    @Test fun missingOrMismatchedSessionCannotStartPlayback() {
        session.watchingIdentity = "someone-else"
        val activity = launch()
        assertTrue(activity.isFinishing)
        assertTrue(outputs.isEmpty())
        assertEquals(0, session.initializations)
    }

    @Test fun systemBarsAndCutoutInsetsKeepVideoAndControlsInsideTheSafeArea() {
        val activity = launch()
        val content = activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
        val bars = Insets.of(0, 32, 0, 24)
        val cutout = Insets.of(30, 0, 0, 0)
        val insets = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.systemBars(), bars)
            .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars(), bars)
            .setInsets(WindowInsetsCompat.Type.displayCutout(), cutout)
            .setInsetsIgnoringVisibility(WindowInsetsCompat.Type.displayCutout(), cutout).build()
        ViewCompat.dispatchApplyWindowInsets(content, insets)
        activity.layout(393, 800)
        val viewport = activity.view(R.id.stream_viewport)
        val normal = viewport.layoutParams as FrameLayout.LayoutParams
        assertEquals(30, normal.leftMargin)
        assertTrue(normal.topMargin >= 32 + 48)
        assertTrue(normal.bottomMargin >= 24 + 48)
        activity.click(R.id.stream_fullscreen_button)
        activity.layout(393, 800)
        val full = viewport.layoutParams as FrameLayout.LayoutParams
        assertEquals(30, full.leftMargin)
        assertEquals(0, full.topMargin)
        assertEquals(0, full.bottomMargin)
        assertTrue(activity.view(R.id.stream_header).paddingTop >= 32)
        assertTrue(activity.view(R.id.stream_footer).paddingBottom >= 24)
    }

    @Test fun openingDuringRoomRecoveryDefersRendererInitializationUntilPlaying() {
        session.rendererAvailable = false
        session.snapshot.put("watchStatus", "reconnecting")
        val activity = launch()
        assertFalse(activity.isFinishing)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_message).visibility)
        session.rendererAvailable = true
        session.emit("playing")
        assertEquals(1, session.initializations)
        assertEquals(View.GONE, activity.view(R.id.stream_message).visibility)
    }

    @Test fun leftSwipesChangeOnlyWindowBrightnessClampAndSurviveRecreation() {
        var activity = launch()
        activity.layout(393, 800)
        Settings.System.putInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128)
        activity.swipe(0.25f, 0.6f, 0.45f)
        assertTrue(activity.window.attributes.screenBrightness > 0.5f)
        assertTrue(activity.window.attributes.screenBrightness < 1f)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_gesture_hud).visibility)
        assertEquals(128, Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS))
        activity.swipe(0.25f, 0.1f, 0.95f)
        assertEquals(0.05f, activity.window.attributes.screenBrightness, 0.001f)
        activity.swipe(0.25f, 0.9f, 0.01f)
        assertEquals(1f, activity.window.attributes.screenBrightness, 0.001f)
        controller!!.recreate()
        activity = controller!!.get()
        assertEquals(1f, activity.window.attributes.screenBrightness, 0.001f)
        assertEquals(128, Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS))
    }

    @Test fun rightSwipesChangeMediaVolumeWithoutChangingVoiceVolumeOrUnmuting() {
        val activity = launch()
        activity.layout(393, 800)
        val audio = activity.getSystemService(AudioManager::class.java)
        val stream = AudioManager.STREAM_MUSIC
        val max = audio.getStreamMaxVolume(stream)
        val min = audio.getStreamMinVolume(stream)
        audio.setStreamVolume(stream, (max + min) / 2, 0)
        val initial = audio.getStreamVolume(stream)
        val voice = audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
        session.snapshot.put("streamSoundEnabled", false).put("muted", true)
        activity.swipe(0.75f, 0.8f, 0.01f)
        assertTrue(audio.getStreamVolume(stream) > initial)
        assertEquals(max, audio.getStreamVolume(stream))
        assertEquals(voice, audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
        assertFalse(session.snapshot.getBoolean("streamSoundEnabled"))
        assertTrue(session.snapshot.getBoolean("muted"))
        activity.swipe(0.75f, 0.1f, 0.99f)
        assertEquals(min, audio.getStreamVolume(stream))
        val percent = if (max > 0) kotlin.math.round(min * 100f / max).toInt() else 0
        assertEquals(activity.getString(R.string.stream_volume_percent, percent), activity.findViewById<TextView>(R.id.stream_gesture_label).text.toString())
        assertEquals(-1f, activity.window.attributes.screenBrightness, 0f)
        assertEquals(stream, activity.volumeControlStream)
    }

    @Test fun hardwareVolumeKeysUseMediaEvenInCommunicationModeAndKeepSoundOff() {
        val activity = launch()
        val audio = activity.getSystemService(AudioManager::class.java)
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, 3, 0)
        val voice = audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
        session.snapshot.put("streamSoundEnabled", false)
        for (action in listOf(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.ACTION_UP)) {
            assertTrue(activity.dispatchKeyEvent(android.view.KeyEvent(action, android.view.KeyEvent.KEYCODE_VOLUME_UP)))
        }
        assertEquals(4, audio.getStreamVolume(AudioManager.STREAM_MUSIC))
        assertEquals(voice, audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
        assertFalse(session.snapshot.getBoolean("streamSoundEnabled"))
        activity.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_VOLUME_DOWN))
        assertEquals(3, audio.getStreamVolume(AudioManager.STREAM_MUSIC))
    }

    @Test
    @Config(shadows = [LimitedStreamAudioManager::class])
    fun fixedAndSystemLimitedMediaVolumeUseTheAcceptedValueForFeedback() {
        val activity = launch()
        activity.layout(393, 800)
        val audio = activity.getSystemService(AudioManager::class.java)
        audio.setStreamVolume(AudioManager.STREAM_MUSIC, 3, 0)
        val voice = audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
        try {
            LimitedStreamAudioManager.fixed = true
            activity.swipe(0.75f, 0.8f, 0.01f)
            activity.dispatchKeyEvent(android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_VOLUME_UP))
            assertEquals(3, audio.getStreamVolume(AudioManager.STREAM_MUSIC))
            LimitedStreamAudioManager.fixed = false
            LimitedStreamAudioManager.limit = 5
            activity.swipe(0.75f, 0.8f, 0.01f)
            assertEquals(5, audio.getStreamVolume(AudioManager.STREAM_MUSIC))
            val percent = kotlin.math.round(5 * 100f / audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)).toInt()
            assertEquals(activity.getString(R.string.stream_volume_percent, percent), activity.findViewById<TextView>(R.id.stream_gesture_label).text.toString())
            assertEquals(voice, audio.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
        } finally {
            LimitedStreamAudioManager.fixed = false
            LimitedStreamAudioManager.limit = Int.MAX_VALUE
        }
    }

    @Test fun audioFailuresKeepFullscreenControlsVisibleWithoutClearingTheVideo() {
        val activity = launch()
        activity.click(R.id.stream_fullscreen_button)
        session.emitAudio(StreamAudioStatus.UNAVAILABLE)
        advance(4)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        assertEquals(View.GONE, activity.view(R.id.stream_message).visibility)
        assertEquals(activity.getString(R.string.stream_audio_unavailable), activity.findViewById<TextView>(R.id.stream_status).text.toString())
        session.emitAudio(StreamAudioStatus.FAILED)
        assertEquals(activity.getString(R.string.stream_audio_failed), activity.findViewById<TextView>(R.id.stream_status).text.toString())
        session.emitAudio(StreamAudioStatus.NO_TRACK)
        assertEquals(activity.getString(R.string.stream_audio_not_shared), activity.findViewById<TextView>(R.id.stream_status).text.toString())
        activity.click(R.id.stream_sound_button)
        assertEquals(activity.getString(R.string.stream_playing), activity.findViewById<TextView>(R.id.stream_status).text.toString())
        controller!!.pause().stop().destroy()
        controller = null
        assertNull(session.audioObserver)
    }

    @Test fun swipeDoesNotToggleChromeAndHudDisappearsAfterReleaseWhileTapStillRevealsChrome() {
        val activity = launch()
        activity.click(R.id.stream_fullscreen_button)
        activity.layout(393, 800)
        advance(3)
        assertEquals(View.INVISIBLE, activity.view(R.id.stream_footer).visibility)
        activity.swipe(0.25f, 0.6f, 0.4f)
        assertEquals(View.INVISIBLE, activity.view(R.id.stream_footer).visibility)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_gesture_hud).visibility)
        advance(1)
        assertEquals(View.GONE, activity.view(R.id.stream_gesture_hud).visibility)
        activity.motion(MotionEvent.ACTION_DOWN, 0.25f, 0.5f)
        activity.motion(MotionEvent.ACTION_UP, 0.25f, 0.5f)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        activity.motion(MotionEvent.ACTION_DOWN, 0.25f, 0.6f)
        activity.motion(MotionEvent.ACTION_MOVE, 0.25f, 0.5f)
        advance(4)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
        activity.motion(MotionEvent.ACTION_UP, 0.25f, 0.5f)
        advance(3)
        assertEquals(View.INVISIBLE, activity.view(R.id.stream_footer).visibility)
    }

    @Test fun chromeAreasAndTouchExplorationDoNotAdjustBrightness() {
        val activity = launch()
        activity.click(R.id.stream_fullscreen_button)
        activity.layout(393, 800)
        activity.swipe(0.25f, 0.01f, 0.3f)
        assertEquals(-1f, activity.window.attributes.screenBrightness, 0f)
        assertEquals(View.GONE, activity.view(R.id.stream_gesture_hud).visibility)
        shadowOf(activity.getSystemService(AccessibilityManager::class.java)).setTouchExplorationEnabled(true)
        activity.swipe(0.25f, 0.6f, 0.3f)
        assertEquals(-1f, activity.window.attributes.screenBrightness, 0f)
        assertEquals(View.VISIBLE, activity.view(R.id.stream_footer).visibility)
    }

    @Test fun backgroundingCancelsAnActiveGestureAndHidesItsHud() {
        val activity = launch()
        activity.layout(393, 800)
        activity.motion(MotionEvent.ACTION_DOWN, 0.25f, 0.6f)
        activity.motion(MotionEvent.ACTION_MOVE, 0.25f, 0.5f)
        val brightness = activity.window.attributes.screenBrightness
        controller!!.pause().stop()
        assertEquals(View.GONE, activity.view(R.id.stream_gesture_hud).visibility)
        activity.motion(MotionEvent.ACTION_MOVE, 0.25f, 0.1f)
        assertEquals(brightness, activity.window.attributes.screenBrightness, 0f)
        controller!!.start().resume()
        assertEquals(brightness, activity.window.attributes.screenBrightness, 0f)
        assertEquals(View.GONE, activity.view(R.id.stream_gesture_hud).visibility)
    }

    @Test
    @Config(sdk = [31], qualifiers = "zh-rCN")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun nativeAppearanceSnapshotsKeepControlsInsidePhoneAndTabletBounds() {
        val activity = launch()
        outputs.single().drawPreview = true
        outputs.single().setWillNotDraw(false)
        val directory = File("build/reports/stream-viewer").apply { mkdirs() }
        fun capture(name: String, width: Int, height: Int) {
            activity.layout(width, height)
            val viewport = activity.view(R.id.stream_viewport)
            val video = outputs.single()
            val expected = if (name == "fullscreen-portrait" || name == "tablet-dark")
                StreamVideoSize(1080, 1920).fit(viewport.width, viewport.height)
            else StreamVideoSize(1920, 1080).fit(viewport.width, viewport.height)
            assertEquals(expected.width, video.width)
            assertEquals(expected.height, video.height)
            assertTrue(kotlin.math.abs(video.left * 2 + video.width - viewport.width) <= 1)
            assertTrue(kotlin.math.abs(video.top * 2 + video.height - viewport.height) <= 1)
            val content = activity.findViewById<View>(android.R.id.content)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            content.draw(Canvas(bitmap))
            File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            val button = activity.view(R.id.stream_fullscreen_button)
            val position = IntArray(2).also(button::getLocationInWindow)
            assertTrue(position[0] >= 0 && position[0] + button.width <= width)
            assertTrue(position[1] >= 0 && position[1] + button.height <= height)
            assertTrue(button.width >= 48 * activity.resources.displayMetrics.density)
        }
        activity.onVideoSizeChanged(StreamVideoSize(1920, 1080))
        capture("portrait-light", 393, 800)
        session.dark = true; session.emit()
        capture("portrait-dark", 393, 800)
        session.emitAudio(StreamAudioStatus.FAILED)
        capture("audio-failure-portrait", 393, 800)
        session.emitAudio(StreamAudioStatus.PLAYING)
        val config = Configuration(activity.resources.configuration).apply { orientation = Configuration.ORIENTATION_LANDSCAPE }
        controller!!.configurationChange(config)
        capture("landscape-dark", 800, 393)
        activity.click(R.id.stream_fullscreen_button)
        capture("fullscreen-landscape", 800, 393)
        session.emitAudio(StreamAudioStatus.UNAVAILABLE)
        capture("audio-failure-fullscreen", 800, 393)
        session.emitAudio(StreamAudioStatus.PLAYING)
        activity.swipe(0.25f, 0.6f, 0.35f)
        capture("gesture-brightness", 800, 393)
        activity.swipe(0.75f, 0.6f, 0.35f)
        capture("gesture-volume", 800, 393)
        activity.onVideoSizeChanged(StreamVideoSize(1080, 1920))
        val portrait = Configuration(activity.resources.configuration).apply { orientation = Configuration.ORIENTATION_PORTRAIT }
        controller!!.configurationChange(portrait)
        capture("fullscreen-portrait", 393, 800)
        activity.click(R.id.stream_fullscreen_button)
        capture("tablet-dark", 800, 1200)
    }
}

@Implements(AudioManager::class)
class LimitedStreamAudioManager : ShadowAudioManager() {
    companion object { var fixed = false; var limit = Int.MAX_VALUE }
    @Implementation fun isVolumeFixed() = fixed
    @Implementation override fun setStreamVolume(stream: Int, value: Int, flags: Int) {
        super.setStreamVolume(stream, if (stream == AudioManager.STREAM_MUSIC) minOf(value, limit) else value, flags)
    }
}

private class FakeStreamRenderer(context: Context) : StreamVideoRenderer(context) {
    var releases = 0
    var drawPreview = false
    override fun draw(canvas: Canvas) {
        if (!drawPreview) { super.draw(canvas); return }
        // A clearly synthetic frame with a visible border makes sizing/cropping inspectable in QA images.
        canvas.drawColor(Color.rgb(25, 38, 49))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(134, 239, 172); strokeWidth = 2f }
        paint.style = Paint.Style.STROKE
        canvas.drawRect(1f, 1f, width - 1f, height - 1f, paint)
        canvas.drawLine(1f, 1f, width - 1f, height - 1f, paint)
        canvas.drawLine(width - 1f, 1f, 1f, height - 1f, paint)
        paint.style = Paint.Style.FILL; paint.textSize = 16f
        canvas.drawText("Test frame", 12f, 24f, paint)
    }
    override fun clearImage() {}
    override fun setMirror(mirror: Boolean) {}
    override fun release() { releases++ }
}

private class FakeStreamSession : StreamViewerSession {
    override var inCall = true
    override var watchingIdentity: String? = "alice"
    var dark = false
    var visible = false
    private var visibleStatus = "playing"
    var starts = 0
    var stops = 0
    var initializations = 0
    var rendererAvailable = true
    var stopsWatching = 0
    var observer: ((JSONObject) -> Unit)? = null
    var audioObserver: ((StreamAudioStatus) -> Unit)? = null
    val snapshot = JSONObject().put("watchStatus", "playing").put("streamSoundEnabled", true).put("muted", false)
        .put("streams", JSONArray().put(JSONObject().put("identity", "alice").put("name", "Alice")))
    override fun settings() = JSONObject().put("dark", dark)
    override fun voiceSnapshot() = snapshot
    override fun observeVoice(observer: (JSONObject) -> Unit): () -> Unit {
        this.observer = observer; observer(snapshot)
        return { this.observer = null }
    }
    override fun observeStreamAudio(observer: (StreamAudioStatus) -> Unit): () -> Unit {
        audioObserver = observer; observer(StreamAudioStatus.PLAYING)
        return { audioObserver = null }
    }
    fun emitAudio(status: StreamAudioStatus) { audioObserver?.invoke(status) }
    override fun initializeVideoRenderer(renderer: SurfaceViewRenderer) {
        check(rendererAvailable) { "Room recovering" }
        initializations++
    }
    override fun videoTrack(): RemoteVideoTrack? = null
    override fun activityStarted() { starts++ }
    override fun activityStopped() { stops++ }
    override fun setViewerVisible(visible: Boolean) {
        this.visible = visible
        if (!visible) { visibleStatus = snapshot.getString("watchStatus"); emit("paused") }
        else emit(if (snapshot.getString("watchStatus") == "paused") visibleStatus else snapshot.getString("watchStatus"))
    }
    override fun stopWatching(identity: String) { if (identity == watchingIdentity) { stopsWatching++; watchingIdentity = null } }
    override fun setStreamSound(enabled: Boolean) { snapshot.put("streamSoundEnabled", enabled); emit() }
    override fun toggleMuted() { snapshot.put("muted", !snapshot.getBoolean("muted")); emit() }
    fun emit(status: String = snapshot.getString("watchStatus")) { snapshot.put("watchStatus", status); observer?.invoke(snapshot) }
}
