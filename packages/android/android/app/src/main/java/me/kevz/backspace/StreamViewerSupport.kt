package me.kevz.backspace

import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import androidx.core.graphics.PathParser
import io.livekit.android.room.track.RemoteVideoTrack
import livekit.org.webrtc.SurfaceViewRenderer
import livekit.org.webrtc.VideoFrame
import org.json.JSONObject
import kotlin.math.roundToInt

internal data class StreamVideoSize(val width: Int, val height: Int) {
    fun fit(maxWidth: Int, maxHeight: Int): StreamVideoSize {
        if (maxWidth <= 0 || maxHeight <= 0) return StreamVideoSize(0, 0)
        val scale = minOf(maxWidth.toDouble() / width, maxHeight.toDouble() / height)
        return StreamVideoSize((width * scale).roundToInt().coerceIn(1, maxWidth),
            (height * scale).roundToInt().coerceIn(1, maxHeight))
    }

    // Use sensor variants so either landscape/portrait orientation is usable.
    fun fullscreenOrientation(): Int? = when {
        width > height -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        height > width -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        else -> null
    }

    companion object {
        fun fromFrame(width: Int, height: Int, rotation: Int): StreamVideoSize? {
            if (width <= 0 || height <= 0) return null
            return if (rotation % 180 == 0) StreamVideoSize(width, height) else StreamVideoSize(height, width)
        }
    }
}

/** Frame metadata only: no bitmap copies or extra video subscriptions. */
internal open class StreamVideoRenderer(context: Context) : SurfaceViewRenderer(context) {
    private val mainHandler = Handler(Looper.getMainLooper())
    var onVideoSize: ((StreamVideoSize) -> Unit)? = null
    @Volatile private var binding: Any? = null
    private var lastSize: StreamVideoSize? = null
    private var lastBinding: Any? = null

    fun bindFrames(active: Boolean) {
        binding = if (active) Any() else null
        mainHandler.removeCallbacksAndMessages(null)
    }

    override fun onFrame(frame: VideoFrame) {
        val current = binding ?: return
        super.onFrame(frame)
        val size = StreamVideoSize.fromFrame(frame.buffer.width, frame.buffer.height, frame.rotation) ?: return
        if (size != lastSize || current !== lastBinding) {
            lastSize = size
            lastBinding = current
            mainHandler.post { if (binding === current) onVideoSize?.invoke(size) }
        }
    }
}

/** Small seam for lifecycle tests; the production adapter always uses the existing Room. */
internal interface StreamViewerSession {
    val inCall: Boolean
    val watchingIdentity: String?
    fun settings(): JSONObject
    fun voiceSnapshot(): JSONObject
    fun observeVoice(observer: (JSONObject) -> Unit): () -> Unit
    fun initializeVideoRenderer(renderer: SurfaceViewRenderer)
    fun videoTrack(): RemoteVideoTrack?
    fun activityStarted()
    fun activityStopped()
    fun setViewerVisible(visible: Boolean)
    fun stopWatching(identity: String)
    fun setStreamSound(enabled: Boolean)
    fun toggleMuted()
}

internal class RuntimeStreamViewerSession(context: Context) : StreamViewerSession {
    private val runtime = BackspaceRuntime.get(context)
    override val inCall get() = runtime.inCall
    override val watchingIdentity get() = runtime.watchingIdentity
    override fun settings() = runtime.settings()
    override fun voiceSnapshot() = runtime.voiceSnapshot()
    override fun observeVoice(observer: (JSONObject) -> Unit) = runtime.observeVoice(observer)
    override fun initializeVideoRenderer(renderer: SurfaceViewRenderer) = runtime.initializeVideoRenderer(renderer)
    override fun videoTrack() = runtime.streamVideoTrack()
    override fun activityStarted() = runtime.activityStarted()
    override fun activityStopped() = runtime.activityStopped()
    override fun setViewerVisible(visible: Boolean) = runtime.setViewerVisible(visible)
    override fun stopWatching(identity: String) = runtime.stopWatching(identity)
    override fun setStreamSound(enabled: Boolean) = runtime.setStreamSound(enabled)
    override fun toggleMuted() = runtime.toggleMuted()
}

internal enum class StreamIcon(val path: String) {
    BACK("M19 12H5 M12 5L5 12L12 19"),
    SOUND("M11 5L6 9H3V15H6L11 19Z M15 8C17 10 17 14 15 16 M18 5C22 9 22 15 18 19"),
    SOUND_OFF("M11 5L6 9H3V15H6L11 19Z M16 9L22 15 M22 9L16 15"),
    BRIGHTNESS("M16 12A4 4 0 1 1 8 12A4 4 0 1 1 16 12 M12 1V3 M12 21V23 M1 12H3 M21 12H23 M4 4L6 6 M18 18L20 20 M4 20L6 18 M18 6L20 4"),
    MIC("M9 5A3 3 0 0 1 15 5V11A3 3 0 0 1 9 11Z M5 11A7 7 0 0 0 19 11 M12 18V22 M8 22H16"),
    MIC_OFF("M9 5A3 3 0 0 1 15 5V11 M9 9V11A3 3 0 0 0 13 14 M5 11A7 7 0 0 0 19 11 M12 18V22 M8 22H16 M3 3L21 21"),
    FULLSCREEN("M8 3H3V8 M16 3H21V8 M21 16V21H16 M8 21H3V16"),
    EXIT_FULLSCREEN("M3 8H8V3 M16 3V8H21 M21 16H16V21 M8 21V16H3")
}

internal class StreamIconDrawable(icon: StreamIcon, color: Int) : Drawable() {
    private val path = requireNotNull(PathParser.createPathFromPathData(icon.path))
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color; style = Paint.Style.STROKE; strokeWidth = 1.8f
        strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
    }
    override fun draw(canvas: Canvas) {
        val save = canvas.save()
        canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
        canvas.scale(bounds.width() / 24f, bounds.height() / 24f)
        canvas.drawPath(path, paint)
        canvas.restoreToCount(save)
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter; invalidateSelf() }
    @Deprecated("Deprecated in Android")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}
