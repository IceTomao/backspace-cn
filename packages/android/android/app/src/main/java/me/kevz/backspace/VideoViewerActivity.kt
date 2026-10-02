package me.kevz.backspace

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.*

/** A private, foreground-only attachment player, independent of the voice Room. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class VideoViewerActivity : AppCompatActivity() {
    companion object {
        internal var runtimeProvider: (Context) -> BackspaceRuntime = { BackspaceRuntime.get(it) }
        internal var engineFactory: ((VideoViewerActivity, VideoPlaybackSession) -> VideoEngine)? = null
    }
    private val runtime by lazy { runtimeProvider(this) }
    private var session: VideoPlaybackSession? = null
    private var controller: VideoPlaybackController? = null
    private lateinit var root: LinearLayout
    private lateinit var title: TextView
    private lateinit var status: TextView
    private lateinit var sound: Button
    private lateinit var retry: Button
    private lateinit var download: Button
    private lateinit var playerView: PlayerView
    private var removeVideoObserver: (() -> Unit)? = null
    private var removeVoiceObserver: (() -> Unit)? = null
    private var started = false
    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val saveFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val destination = result.data?.data
        val current = session
        if (result.resultCode == Activity.RESULT_OK && destination != null && current != null) {
            download.isEnabled = false
            status.setText(R.string.video_saving)
            activityScope.launch {
                try { runtime.download(current.url, destination); status.setText(R.string.video_saved) }
                catch (error: CancellationException) { throw error }
                catch (_: Exception) { status.setText(R.string.video_save_failed) }
                finally { download.isEnabled = true }
            }
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val current = runtime.videoPlayback ?: run { finish(); return }
        session = current
        // Revalidate even after Activity recreation; playback never carries auth headers.
        try { runtime.validateDownload(current.url) }
        catch (_: Exception) { runtime.closeVideo(current); finish(); return }
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        header.addView(Button(this).apply { setText(R.string.stream_back); setOnClickListener { finish() } })
        title = TextView(this).apply { text = current.title; textSize = 16f; maxLines = 2 }
        header.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(header)
        playerView = PlayerView(this).apply {
            setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            setShowNextButton(false); setShowPreviousButton(false)
            setBackgroundColor(Color.BLACK)
        }
        root.addView(playerView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        status = TextView(this).apply { textSize = 14f; textAlignment = View.TEXT_ALIGNMENT_CENTER }
        root.addView(status)
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        sound = Button(this).apply { setOnClickListener { controller?.toggleMute(); updateSound() } }
        retry = Button(this).apply {
            setText(R.string.video_retry); visibility = View.GONE
            setOnClickListener { visibility = View.GONE; controller?.retry() }
        }
        download = Button(this).apply {
            setText(R.string.video_download)
            setOnClickListener {
                try {
                    saveFile.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(current.mimetype).putExtra(Intent.EXTRA_TITLE,
                            current.title.replace(Regex("[/\\\\\\p{Cntrl}]"), "_").ifBlank { "video.mp4" }))
                } catch (_: Exception) { status.setText(R.string.video_save_failed) }
            }
        }
        for (button in listOf(sound, retry, download)) actions.addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(actions)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); insets
        }
        setContentView(root)
        applyTheme(); updateSound()
        controller = VideoPlaybackController(current) { engineFactory?.invoke(this, current) ?: createEngine(current) }
        removeVideoObserver = runtime.observeVideo {
            if (it !== current) { controller?.stop(); finish() }
        }
        var wasInCall = runtime.inCall
        removeVoiceObserver = runtime.observeVoice {
            if (runtime.inCall != wasInCall) {
                wasInCall = runtime.inCall
                (playerView.player as? ExoPlayer)?.setAudioAttributes(mediaAudioAttributes(), !wasInCall)
            }
        }
    }

    private fun mediaAudioAttributes() = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build()
    private fun createEngine(current: VideoPlaybackSession): VideoEngine {
        val dataSource = OkHttpDataSource.Factory(runtime.videoHttpClient())
        val player = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(dataSource)).build()
        player.setAudioAttributes(mediaAudioAttributes(), !runtime.inCall)
        player.setHandleAudioBecomingNoisy(true)
        playerView.player = player
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (playerView.player !== player) return
                status.setText(when (state) {
                    Player.STATE_BUFFERING -> R.string.video_loading
                    Player.STATE_ENDED -> R.string.video_ended
                    else -> R.string.video_ready
                })
            }
            override fun onIsPlayingChanged(playing: Boolean) {
                if (playerView.player !== player) return
                if (playing) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            override fun onPlayerError(error: PlaybackException) {
                if (playerView.player !== player) return
                status.setText(if (error.errorCode in 2000..2999) R.string.video_network_error else R.string.video_decode_error)
                retry.visibility = View.VISIBLE
            }
        })
        return object : VideoEngine {
            override val positionMs get() = player.currentPosition
            override fun prepare(positionMs: Long, play: Boolean, muted: Boolean) {
                status.setText(R.string.video_loading)
                player.setMediaItem(MediaItem.Builder().setUri(current.url)
                    .setMediaMetadata(MediaMetadata.Builder().setTitle(current.title).build()).build(), positionMs)
                player.volume = if (muted) 0f else 1f
                player.playWhenReady = play
                player.prepare()
            }
            override fun mute(muted: Boolean) { player.volume = if (muted) 0f else 1f }
            override fun release() {
                playerView.player = null
                player.release()
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    private fun updateSound() { sound.setText(if (session?.muted == true) R.string.video_unmute else R.string.video_mute) }
    private fun applyTheme() {
        val dark = runtime.settings().optBoolean("dark")
        val text = if (dark) Color.WHITE else Color.BLACK
        root.setBackgroundColor(if (dark) Color.rgb(11, 11, 16) else Color.WHITE)
        title.setTextColor(text); status.setTextColor(text)
        WindowCompat.getInsetsController(window, root).apply {
            isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark
        }
    }
    override fun onConfigurationChanged(config: Configuration) {
        super.onConfigurationChanged(config)
        if (::root.isInitialized) { applyTheme(); ViewCompat.requestApplyInsets(root) }
    }
    override fun onStart() {
        super.onStart()
        if (controller == null || isFinishing) return
        started = true
        runtime.activityStarted()
        controller?.start()
    }
    override fun onStop() {
        controller?.stop()
        if (started) { started = false; runtime.activityStopped() }
        super.onStop()
    }
    override fun onDestroy() {
        controller?.stop()
        removeVideoObserver?.invoke(); removeVoiceObserver?.invoke()
        if (!isChangingConfigurations) session?.let(runtime::closeVideo)
        activityScope.cancel()
        super.onDestroy()
    }
}
