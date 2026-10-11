package me.kevz.backspace

import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import io.livekit.android.room.track.RemoteVideoTrack
import org.json.JSONObject
import kotlin.math.roundToInt

/** Uses the existing Room. Rotating or expanding this Activity never creates a second call. */
class StreamViewerActivity : AppCompatActivity() {
    companion object {
        internal var sessionFactory: (Context) -> StreamViewerSession = { RuntimeStreamViewerSession(it) }
        internal var rendererFactory: (Context) -> StreamVideoRenderer = { StreamVideoRenderer(it) }
        private const val CONTROLS_TIMEOUT_MS = 3_000L
    }
    private val session by lazy { sessionFactory(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val accessibility by lazy { getSystemService(AccessibilityManager::class.java) }
    private val audio by lazy { getSystemService(AudioManager::class.java) }
    private lateinit var root: FrameLayout
    private lateinit var viewport: FrameLayout
    private lateinit var renderer: StreamVideoRenderer
    private lateinit var header: LinearLayout
    private lateinit var footer: FrameLayout
    private lateinit var controlBubble: LinearLayout
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var message: TextView
    private lateinit var gestures: StreamGestureView
    private lateinit var gestureHud: LinearLayout
    private lateinit var gestureLabel: TextView
    private lateinit var gestureProgress: ProgressBar
    private lateinit var back: ImageButton
    private lateinit var sound: StreamAction
    private lateinit var mic: StreamAction
    private lateinit var fullscreen: StreamAction
    private var identity = ""
    private var attached: RemoteVideoTrack? = null
    private var removeObserver: (() -> Unit)? = null
    private var rendererInitialized = false
    private var started = false
    private var destroyed = false
    private var isFullscreen = false
    private var controlsVisible = true
    private var previousOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var videoSize: StreamVideoSize? = null
    private var watchStatus = "connecting"
    private var voiceState = JSONObject()
    private var viewerBrightness: Float? = null
    private var gestureActive = false
    private var initialBrightness = 0.5f
    private var initialVolume = 0
    private var minVolume = 0
    private var maxVolume = 1
    // LiveKit's default AudioSwitchHandler uses USAGE_VOICE_COMMUNICATION.
    private val playbackVolumeStream = AudioManager.STREAM_VOICE_CALL
    private var safeBars = Insets.NONE
    private var cutout = Insets.NONE
    private val hideControls = Runnable { if (canAutoHide()) setControlsVisible(false) }
    private val hideGestureHud = Runnable { gestureHud.visibility = View.GONE }
    private val explorationListener = AccessibilityManager.TouchExplorationStateChangeListener {
        if (!destroyed && ::root.isInitialized) { cancelVideoGesture(); revealControls() }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        identity = intent.getStringExtra("identity").orEmpty()
        if (identity.isBlank() || session.watchingIdentity != identity || !session.inCall) { finish(); return }
        isFullscreen = state?.getBoolean("fullscreen") ?: false
        previousOrientation = state?.getInt("previousOrientation") ?: requestedOrientation
        videoSize = StreamVideoSize.fromFrame(state?.getInt("videoWidth") ?: 0, state?.getInt("videoHeight") ?: 0, 0)
        viewerBrightness = state?.takeIf { it.containsKey("viewerBrightness") }?.getFloat("viewerBrightness")?.coerceIn(0.05f, 1f)
        volumeControlStream = playbackVolumeStream
        buildContent()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            safeBars = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            applyLayout()
            insets
        }
        setContentView(root)
        initializeRendererIfReady()
        renderer.onVideoSize = ::onVideoSizeChanged
        removeObserver = session.observeVoice(::update)
        accessibility.addTouchExplorationStateChangeListener(explorationListener)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = leaveOrExitFullscreen()
        })
        applyLayout(); applyTheme(); applySystemBars()
        if (isFullscreen) applyVideoOrientation()
        ViewCompat.requestApplyInsets(root)
    }

    private fun buildContent() {
        root = FrameLayout(this)
        viewport = FrameLayout(this).apply {
            id = R.id.stream_viewport
            setBackgroundColor(Color.BLACK)
            setOnClickListener { toggleControls() }
            addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitVideo() }
        }
        root.addView(viewport, FrameLayout.LayoutParams(-1, -1))
        renderer = rendererFactory(this).apply { setOnClickListener { toggleControls() } }
        viewport.addView(renderer, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        message = TextView(this).apply {
            id = R.id.stream_message
            textSize = 14f; gravity = Gravity.CENTER
            setTextColor(Color.rgb(239, 239, 239))
            setPadding(dp(24), dp(16), dp(24), dp(16))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        viewport.addView(message, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        buildVideoGestures()
        header = LinearLayout(this).apply {
            id = R.id.stream_header
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateViewport() }
        }
        back = ImageButton(this).apply {
            id = R.id.stream_back_button
            contentDescription = getString(R.string.stream_back)
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setOnClickListener { leaveOrExitFullscreen() }
        }
        header.addView(back, LinearLayout.LayoutParams(dp(48), dp(48)))
        val heading = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), 0, dp(12), 0)
        }
        title = TextView(this).apply {
            id = R.id.stream_title
            textSize = 16f; setTypeface(typeface, Typeface.BOLD)
            maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }
        status = TextView(this).apply { id = R.id.stream_status; textSize = 12f; maxLines = 1 }
        heading.addView(title); heading.addView(status)
        header.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(header, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        footer = FrameLayout(this).apply {
            id = R.id.stream_footer
            addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateViewport() }
        }
        controlBubble = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            setPadding(dp(8), dp(6), dp(8), dp(6))
        }
        sound = StreamAction(R.id.stream_sound_button, R.string.stream_sound_label) {
            session.setStreamSound(!session.voiceSnapshot().optBoolean("streamSoundEnabled", true))
        }
        mic = StreamAction(R.id.stream_mic_button, R.string.stream_mic_label) { session.toggleMuted() }
        fullscreen = StreamAction(R.id.stream_fullscreen_button, R.string.stream_fullscreen) { setFullscreen(!isFullscreen) }
        listOf(sound, mic, fullscreen).forEach { controlBubble.addView(it.container) }
        footer.addView(controlBubble, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        root.addView(footer, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
    }

    private fun buildVideoGestures() {
        gestures = StreamGestureView(this).apply {
            id = R.id.stream_gestures
            setOnClickListener { toggleControls() }
            allowGesture = { _, y ->
                started && !accessibility.isTouchExplorationEnabled &&
                    !(isFullscreen && controlsVisible && (viewport.top + y < header.bottom || viewport.top + y >= footer.top))
            }
            onGestureStart = ::startVideoGesture
            onGestureChange = ::changeVideoGesture
            onGestureEnd = ::endVideoGesture
        }
        viewport.addView(gestures, FrameLayout.LayoutParams(-1, -1))
        gestureHud = LinearLayout(this).apply {
            id = R.id.stream_gesture_hud
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = rounded(Color.argb(235, 37, 37, 48), 16f)
            visibility = View.GONE
        }
        gestureLabel = TextView(this).apply {
            id = R.id.stream_gesture_label
            textSize = 14f; gravity = Gravity.CENTER_VERTICAL
            setTextColor(Color.rgb(239, 239, 239))
            compoundDrawablePadding = dp(8)
        }
        gestureProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = ColorStateList.valueOf(Color.rgb(134, 239, 172))
            progressBackgroundTintList = ColorStateList.valueOf(Color.rgb(92, 92, 104))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        gestureHud.addView(gestureLabel, LinearLayout.LayoutParams(-1, -2))
        gestureHud.addView(gestureProgress, LinearLayout.LayoutParams(-1, dp(4)).apply { topMargin = dp(10) })
        viewport.addView(gestureHud, FrameLayout.LayoutParams(dp(180), -2, Gravity.CENTER))
    }

    private fun startVideoGesture(kind: StreamGesture) {
        gestureActive = true
        handler.removeCallbacks(hideControls)
        handler.removeCallbacks(hideGestureHud)
        if (kind == StreamGesture.BRIGHTNESS) {
            initialBrightness = viewerBrightness ?: window.attributes.screenBrightness.takeIf { it >= 0f }
                ?: (Settings.System.getInt(contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) / 255f)
            initialBrightness = initialBrightness.coerceIn(0.05f, 1f)
        } else {
            minVolume = audio.getStreamMinVolume(playbackVolumeStream)
            maxVolume = audio.getStreamMaxVolume(playbackVolumeStream).coerceAtLeast(minVolume)
            initialVolume = audio.getStreamVolume(playbackVolumeStream)
        }
    }

    private fun changeVideoGesture(kind: StreamGesture, change: Float) {
        val percent = if (kind == StreamGesture.BRIGHTNESS) {
            val brightness = (initialBrightness + change * 0.95f).coerceIn(0.05f, 1f)
            viewerBrightness = brightness
            window.attributes = window.attributes.apply { screenBrightness = brightness }
            (brightness * 100).roundToInt()
        } else {
            val volume = (initialVolume + change * (maxVolume - minVolume)).roundToInt().coerceIn(minVolume, maxVolume)
            if (!audio.isVolumeFixed && volume != audio.getStreamVolume(playbackVolumeStream)) {
                // Read back the accepted value; device/safe-volume limits may refuse the requested level.
                audio.setStreamVolume(playbackVolumeStream, volume, 0)
            }
            if (maxVolume > 0) (audio.getStreamVolume(playbackVolumeStream) * 100f / maxVolume).roundToInt() else 0
        }
        val icon = if (kind == StreamGesture.BRIGHTNESS) StreamIcon.BRIGHTNESS else if (percent == 0) StreamIcon.SOUND_OFF else StreamIcon.SOUND
        val drawable = StreamIconDrawable(icon, Color.rgb(134, 239, 172)).apply { setBounds(0, 0, dp(24), dp(24)) }
        gestureLabel.setCompoundDrawables(drawable, null, null, null)
        gestureLabel.text = getString(if (kind == StreamGesture.BRIGHTNESS) R.string.stream_brightness_percent else R.string.stream_volume_percent, percent)
        gestureProgress.progress = percent
        gestureHud.visibility = View.VISIBLE
    }

    private fun endVideoGesture() {
        gestureActive = false
        handler.postDelayed(hideGestureHud, 1_000L)
        if (controlsVisible && canAutoHide()) handler.postDelayed(hideControls, CONTROLS_TIMEOUT_MS)
    }

    private fun cancelVideoGesture() {
        gestures.cancelGesture()
        handler.removeCallbacks(hideGestureHud)
        gestureHud.visibility = View.GONE
    }

    private fun update(state: JSONObject) {
        if (destroyed || isFinishing) return
        if (!session.inCall || session.watchingIdentity != identity) { finish(); return }
        voiceState = state
        val streams = state.optJSONArray("streams")
        val stream = (0 until (streams?.length() ?: 0)).mapNotNull { streams?.optJSONObject(it) }
            .firstOrNull { it.optString("identity") == identity }
        title.text = stream?.optString("name")?.takeIf { it.isNotBlank() } ?: identity.substringAfter(':', identity)
        val previousStatus = watchStatus
        watchStatus = state.optString("watchStatus", "connecting")
        val statusText = getString(when (watchStatus) {
            "playing" -> R.string.stream_playing
            "ended" -> R.string.stream_ended
            "paused" -> R.string.stream_paused
            "reconnecting" -> R.string.stream_reconnecting
            "unavailable" -> R.string.stream_unavailable
            else -> R.string.stream_connecting
        })
        status.text = statusText
        message.text = statusText
        message.visibility = if (watchStatus == "playing") View.GONE else View.VISIBLE
        if (started && watchStatus == "playing") window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (started && watchStatus == "playing") initializeRendererIfReady()
        attach(if (started && watchStatus == "playing") session.videoTrack() else null)
        applyTheme()
        if (previousStatus != watchStatus || watchStatus != "playing") revealControls()
    }

    private fun initializeRendererIfReady() {
        if (rendererInitialized) return
        try {
            session.initializeVideoRenderer(renderer)
            rendererInitialized = true
            renderer.setMirror(false)
        } catch (_: IllegalStateException) {
            // A Room can be absent during recovery. Initialize on the next playing snapshot.
        }
    }

    private fun attach(track: RemoteVideoTrack?) {
        if (attached === track || !rendererInitialized) return
        renderer.bindFrames(false)
        attached?.removeRenderer(renderer)
        renderer.clearImage()
        attached = track
        if (track != null) {
            // Wait for the new attachment's dimensions instead of using stale metadata.
            videoSize = null
            fitVideo()
            renderer.bindFrames(true)
            track.addRenderer(renderer)
        }
    }

    internal fun onVideoSizeChanged(size: StreamVideoSize) {
        if (destroyed || isFinishing) return
        videoSize = size
        fitVideo()
        if (isFullscreen) applyVideoOrientation()
    }

    private fun fitVideo() {
        val size = videoSize?.fit(viewport.width, viewport.height) ?: StreamVideoSize(viewport.width, viewport.height)
        if (size.width <= 0 || size.height <= 0) return
        val params = renderer.layoutParams as FrameLayout.LayoutParams
        if (params.width != size.width || params.height != size.height) {
            params.width = size.width; params.height = size.height
            renderer.layoutParams = params
        }
    }

    private fun setFullscreen(value: Boolean) {
        if (isFullscreen == value) return
        cancelVideoGesture()
        if (value) previousOrientation = requestedOrientation
        isFullscreen = value
        if (value) applyVideoOrientation() else requestedOrientation = previousOrientation
        applyLayout(); applyTheme(); applySystemBars(); revealControls()
        ViewCompat.requestApplyInsets(root)
    }

    private fun applyVideoOrientation() {
        val orientation = videoSize?.fullscreenOrientation() ?: return
        if (requestedOrientation != orientation) requestedOrientation = orientation
    }

    private fun leaveOrExitFullscreen() { if (isFullscreen) setFullscreen(false) else finish() }
    private fun toggleControls() {
        if (!isFullscreen) return
        if (controlsVisible && canAutoHide()) setControlsVisible(false) else revealControls()
    }
    private fun canAutoHide() = isFullscreen && started && watchStatus == "playing" && !gestureActive && !accessibility.isTouchExplorationEnabled
    private fun revealControls() {
        setControlsVisible(true)
        if (canAutoHide()) handler.postDelayed(hideControls, CONTROLS_TIMEOUT_MS)
    }
    private fun setControlsVisible(visible: Boolean) {
        handler.removeCallbacks(hideControls)
        controlsVisible = visible
        // INVISIBLE preserves layout while removing hidden controls from hit testing and accessibility.
        header.visibility = if (visible) View.VISIBLE else View.INVISIBLE
        footer.visibility = if (visible) View.VISIBLE else View.INVISIBLE
    }

    private fun applyLayout() {
        val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        header.setPadding(safeBars.left + dp(8), safeBars.top + dp(if (landscape) 0 else 4), safeBars.right + dp(8), dp(if (landscape) 0 else 4))
        footer.setPadding(safeBars.left + dp(8), dp(if (landscape) 4 else 12), safeBars.right + dp(8), safeBars.bottom + dp(if (landscape) 4 else 12))
        listOf(sound, mic, fullscreen).forEach { it.label.visibility = if (landscape) View.GONE else View.VISIBLE }
        updateViewport()
    }

    private fun updateViewport() {
        val params = viewport.layoutParams as FrameLayout.LayoutParams
        val left = if (isFullscreen) cutout.left else safeBars.left
        val right = if (isFullscreen) cutout.right else safeBars.right
        val top = if (isFullscreen) cutout.top else header.measuredHeight
        val bottom = if (isFullscreen) cutout.bottom else footer.measuredHeight
        if (params.leftMargin != left || params.rightMargin != right || params.topMargin != top || params.bottomMargin != bottom) {
            params.setMargins(left, top, right, bottom)
            viewport.layoutParams = params
        }
    }

    private fun applySystemBars() {
        WindowCompat.getInsetsController(window, root).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (isFullscreen) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun applyTheme() {
        val dark = isFullscreen || session.settings().optBoolean("dark")
        val base = if (dark) Color.rgb(11, 11, 16) else Color.rgb(244, 244, 246)
        val elevated = if (dark) Color.rgb(37, 37, 48) else Color.WHITE
        val primary = if (dark) Color.rgb(239, 239, 239) else Color.rgb(27, 31, 39)
        val secondary = if (dark) Color.rgb(160, 160, 170) else Color.rgb(69, 75, 87)
        val mint = if (dark) Color.rgb(134, 239, 172) else Color.rgb(21, 120, 84)
        val rose = if (dark) Color.rgb(253, 164, 175) else Color.rgb(183, 57, 80)
        root.setBackgroundColor(if (isFullscreen) Color.BLACK else base)
        header.setBackgroundColor(if (isFullscreen) Color.argb(180, 11, 11, 16) else base)
        footer.setBackgroundColor(if (isFullscreen) Color.TRANSPARENT else base)
        controlBubble.background = rounded(if (isFullscreen) Color.argb(235, 37, 37, 48) else elevated, 32f)
        controlBubble.elevation = dp(2).toFloat()
        title.setTextColor(primary)
        status.setTextColor(if (watchStatus == "playing") mint else secondary)
        back.setImageDrawable(StreamIconDrawable(if (isFullscreen) StreamIcon.EXIT_FULLSCREEN else StreamIcon.BACK, primary))
        back.contentDescription = getString(if (isFullscreen) R.string.stream_exit_fullscreen else R.string.stream_back)
        back.background = ripple(Color.TRANSPARENT, primary)
        val soundEnabled = voiceState.optBoolean("streamSoundEnabled", true)
        val muted = voiceState.optBoolean("muted") || voiceState.optBoolean("deafened")
        sound.style(if (soundEnabled) StreamIcon.SOUND else StreamIcon.SOUND_OFF,
            if (soundEnabled) mint else rose, if (soundEnabled) R.string.stream_sound_off else R.string.stream_sound_on)
        mic.style(if (muted) StreamIcon.MIC_OFF else StreamIcon.MIC,
            if (muted) rose else secondary, if (voiceState.optBoolean("muted")) R.string.stream_unmute else R.string.stream_mute)
        fullscreen.label.setText(if (isFullscreen) R.string.stream_exit_fullscreen else R.string.stream_fullscreen)
        fullscreen.style(if (isFullscreen) StreamIcon.EXIT_FULLSCREEN else StreamIcon.FULLSCREEN, primary,
            if (isFullscreen) R.string.stream_exit_fullscreen else R.string.stream_fullscreen)
        listOf(sound, mic, fullscreen).forEach { it.label.setTextColor(secondary) }
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    private inner class StreamAction(id: Int, labelText: Int, action: () -> Unit) {
        val container = LinearLayout(this@StreamViewerActivity).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(88), -2)
        }
        val button = ImageButton(this@StreamViewerActivity).apply {
            this.id = id
            scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setOnClickListener { action(); revealControls() }
        }
        val label = TextView(this@StreamViewerActivity).apply {
            setText(labelText); textSize = 11f; gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, 0)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            setOnClickListener { button.performClick() }
        }
        init {
            container.addView(button, LinearLayout.LayoutParams(dp(48), dp(48)))
            container.addView(label, LinearLayout.LayoutParams(-1, -2))
        }
        fun style(icon: StreamIcon, color: Int, description: Int) {
            button.setImageDrawable(StreamIconDrawable(icon, color))
            button.background = ripple((color and 0x00ffffff) or (0x18 shl 24), color)
            button.contentDescription = getString(description)
            button.tooltipText = getString(description)
        }
    }

    private fun rounded(color: Int, radius: Float) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
    }
    private fun ripple(color: Int, foreground: Int) = RippleDrawable(
        ColorStateList.valueOf((foreground and 0x00ffffff) or (0x33 shl 24)), rounded(color, 24f), rounded(Color.WHITE, 24f))
    private fun dp(value: Int) = dp(value.toFloat())
    private fun dp(value: Float) = (value * resources.displayMetrics.density + 0.5f).toInt()

    override fun onConfigurationChanged(config: Configuration) {
        super.onConfigurationChanged(config)
        if (!::root.isInitialized) return
        cancelVideoGesture()
        applyLayout(); applyTheme(); applySystemBars()
        ViewCompat.requestApplyInsets(root)
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("fullscreen", isFullscreen)
        outState.putInt("previousOrientation", previousOrientation)
        viewerBrightness?.let { outState.putFloat("viewerBrightness", it) }
        videoSize?.let { outState.putInt("videoWidth", it.width); outState.putInt("videoHeight", it.height) }
        super.onSaveInstanceState(outState)
    }
    override fun onStart() {
        super.onStart()
        if (!::root.isInitialized || isFinishing || started) return
        started = true
        viewerBrightness?.let { window.attributes = window.attributes.apply { screenBrightness = it } }
        session.activityStarted()
        session.setViewerVisible(true)
        update(session.voiceSnapshot())
        applySystemBars(); revealControls()
    }
    override fun onStop() {
        if (::gestures.isInitialized) cancelVideoGesture()
        handler.removeCallbacks(hideControls)
        if (started) {
            started = false
            session.setViewerVisible(false)
            attach(null)
            session.activityStopped()
        }
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        super.onStop()
    }
    override fun onDestroy() {
        destroyed = true
        handler.removeCallbacks(hideControls)
        handler.removeCallbacks(hideGestureHud)
        removeObserver?.invoke(); removeObserver = null
        if (::root.isInitialized) {
            accessibility.removeTouchExplorationStateChangeListener(explorationListener)
            renderer.onVideoSize = null
            renderer.bindFrames(false)
            attach(null)
            if (rendererInitialized) renderer.release()
            if (!isChangingConfigurations) session.stopWatching(identity)
        }
        super.onDestroy()
    }
}
