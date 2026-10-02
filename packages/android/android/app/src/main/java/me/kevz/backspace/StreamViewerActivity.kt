package me.kevz.backspace

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import io.livekit.android.room.track.RemoteVideoTrack
import livekit.org.webrtc.SurfaceViewRenderer
import org.json.JSONObject

/** Uses the existing Room. Opening this Activity never creates a second call. */
class StreamViewerActivity : AppCompatActivity() {
    private val runtime get() = BackspaceRuntime.get(this)
    private lateinit var renderer: SurfaceViewRenderer
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var sound: Button
    private lateinit var mic: Button
    private var identity = ""
    private var attached: RemoteVideoTrack? = null
    private var removeObserver: (() -> Unit)? = null
    private var rendererInitialized = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        identity = intent.getStringExtra("identity").orEmpty()
        if (identity.isBlank() || runtime.watchingIdentity != identity || !runtime.inCall) { finish(); return }
        val dark = runtime.settings().optBoolean("dark")
        val textColor = if (dark) Color.WHITE else Color.BLACK
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(if (dark) Color.rgb(11, 11, 16) else Color.WHITE)
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        controls.addView(Button(this).apply { setText(R.string.stream_back); setOnClickListener { finish() } })
        title = TextView(this).apply { setTextColor(textColor); textSize = 16f; maxLines = 2 }
        controls.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(controls)
        renderer = SurfaceViewRenderer(this)
        root.addView(renderer, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        status = TextView(this).apply { setTextColor(textColor); textSize = 14f; textAlignment = View.TEXT_ALIGNMENT_CENTER }
        root.addView(status)
        val audioControls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        sound = Button(this).apply { setOnClickListener { runtime.setStreamSound(!runtime.voiceSnapshot().optBoolean("streamSoundEnabled", true)) } }
        mic = Button(this).apply { setOnClickListener { runtime.toggleMuted() } }
        audioControls.addView(sound, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        audioControls.addView(mic, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(audioControls)
        setContentView(root)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        runtime.initializeVideoRenderer(renderer)
        rendererInitialized = true
        removeObserver = runtime.observeVoice { update(it) }
    }

    private fun update(state: JSONObject) {
        if (isFinishing) return
        if (!runtime.inCall || runtime.watchingIdentity != identity) { finish(); return }
        val streams = state.optJSONArray("streams")
        val stream = (0 until (streams?.length() ?: 0)).mapNotNull { streams?.optJSONObject(it) }.firstOrNull { it.optString("identity") == identity }
        title.text = stream?.optString("name")?.takeIf { it.isNotBlank() } ?: identity.substringAfter(':', identity)
        sound.setText(if (state.optBoolean("streamSoundEnabled", true)) R.string.stream_sound_off else R.string.stream_sound_on)
        mic.setText(if (state.optBoolean("muted")) R.string.stream_unmute else R.string.stream_mute)
        val watchStatus = state.optString("watchStatus")
        status.setText(when (watchStatus) {
            "playing" -> R.string.stream_playing
            "ended" -> R.string.stream_ended
            "paused" -> R.string.stream_paused
            "reconnecting" -> R.string.stream_reconnecting
            "unavailable" -> R.string.stream_unavailable
            else -> R.string.stream_connecting
        })
        if (watchStatus == "playing") window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        attach(runtime.streamVideoTrack())
    }

    private fun attach(track: RemoteVideoTrack?) {
        if (attached === track || !rendererInitialized) return
        attached?.removeRenderer(renderer)
        renderer.clearImage()
        attached = track
        track?.addRenderer(renderer)
    }

    override fun onStart() {
        super.onStart()
        if (!rendererInitialized) return
        runtime.activityStarted()
        runtime.setViewerVisible(true)
    }
    override fun onStop() {
        if (rendererInitialized) {
            runtime.setViewerVisible(false)
            attach(null)
            runtime.activityStopped()
        }
        super.onStop()
    }
    override fun onDestroy() {
        removeObserver?.invoke()
        removeObserver = null
        if (rendererInitialized) {
            attach(null)
            renderer.release()
            if (!isChangingConfigurations) runtime.stopWatching(identity)
        }
        super.onDestroy()
    }
}
