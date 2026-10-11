package me.kevz.backspace

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.livekit.android.room.track.RemoteAudioTrack
import livekit.org.webrtc.AudioTrackSink
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.roundToInt

internal enum class StreamAudioStatus { PAUSED, MUTED, NO_TRACK, CONNECTING, PLAYING, UNAVAILABLE, FAILED }

internal interface StreamAudioSource {
    val key: Any
    fun silenceDefaultPlayback()
    fun addSink(sink: AudioTrackSink)
    fun removeSink(sink: AudioTrackSink)
}

internal class LiveKitStreamAudioSource(private val track: RemoteAudioTrack) : StreamAudioSource {
    override val key: Any get() = track
    override fun silenceDefaultPlayback() = track.setVolume(0.0)
    override fun addSink(sink: AudioTrackSink) = track.addSink(sink)
    override fun removeSink(sink: AudioTrackSink) = track.removeSink(sink)
}

internal data class StreamPcmFormat(val rate: Int, val channels: Int)
internal interface StreamPcmOutput {
    fun play()
    fun write(bytes: ByteArray, offset: Int, length: Int): Int
    fun close()
}

/** Owns no audio focus or communication routing; the existing Room still owns both. */
internal class AndroidStreamPcmOutput(format: StreamPcmFormat) : StreamPcmOutput {
    internal val track: AudioTrack
    init {
        val mask = if (format.channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
        val minimum = AudioTrack.getMinBufferSize(format.rate, mask, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "Unsupported PCM format: $format" }
        track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(format.rate).setChannelMask(mask)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(minimum, format.rate * format.channels * 2 / 20))
            .build()
        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            error("Media AudioTrack initialization failed")
        }
    }
    override fun play() = track.play()
    override fun write(bytes: ByteArray, offset: Int, length: Int) =
        track.write(bytes, offset, length, AudioTrack.WRITE_NON_BLOCKING)
    override fun close() {
        try { if (track.playState == AudioTrack.PLAYSTATE_PLAYING) track.pause(); track.flush() }
        finally { track.release() }
    }
}

/** One binding owns one sink and worker. Retired bindings cannot enqueue or report into a new session. */
internal class StreamAudioPlayback(
    private val outputFactory: (StreamPcmFormat) -> StreamPcmOutput = ::AndroidStreamPcmOutput,
    private val mainHandler: Handler = Handler(Looper.getMainLooper()),
    private val onStatus: (StreamAudioStatus) -> Unit,
) {
    private var binding: Binding? = null
    var status = StreamAudioStatus.PAUSED
        private set
    private fun setStatus(value: StreamAudioStatus) { status = value; onStatus(value) }
    private val noFrames = Runnable {
        binding?.takeIf { !it.receivedFrames }?.let { Log.d(TAG, "Subscribed stream audio has not delivered PCM yet") }
    }

    fun update(source: StreamAudioSource?, gain: Double) {
        if (source != null && binding?.source?.key === source.key) {
            binding?.gain = gain.coerceIn(0.0, 4.0)
            return
        }
        stop()
        if (source == null) return
        val next = Binding(source, gain.coerceIn(0.0, 4.0))
        binding = next
        try {
            source.silenceDefaultPlayback()
            source.addSink(next)
            next.worker.start()
            setStatus(StreamAudioStatus.CONNECTING)
            mainHandler.postDelayed(noFrames, 5_000)
        } catch (error: Exception) {
            next.fail(error)
        }
    }

    fun stop() {
        mainHandler.removeCallbacks(noFrames)
        val old = binding
        binding = null
        old?.close()
        status = StreamAudioStatus.PAUSED
    }

    private inner class Binding(val source: StreamAudioSource, @Volatile var gain: Double) : AudioTrackSink {
        private val lock = ReentrantLock()
        private val available = lock.newCondition()
        private val queue = ArrayDeque<Packet>()
        private var queuedSeconds = 0.0
        private val outputLock = Any()
        private var output: StreamPcmOutput? = null
        @Volatile private var active = true
        @Volatile private var failurePending = false
        @Volatile var receivedFrames = false
            private set
        private var reportedPlaying = false
        val worker = Thread(::run, "StreamMediaPlayback").apply { isDaemon = true }

        override fun onData(data: ByteBuffer?, bits: Int, rate: Int, channels: Int, frames: Int, timestamp: Long) {
            if (!active || failurePending || data == null) return
            val bytes = frames.toLong() * channels * 2
            if (bits != 16 || rate !in 8_000..192_000 || channels !in 1..2 || frames <= 0 ||
                bytes > data.remaining() || frames.toDouble() / rate > 0.1) {
                fail(IllegalArgumentException("Invalid stream PCM: bits=$bits rate=$rate channels=$channels frames=$frames"))
                return
            }
            // The JNI buffer is borrowed: copy it before returning, without changing its position.
            val copy = ByteArray(bytes.toInt())
            data.duplicate().get(copy)
            lock.withLock {
                if (!active || failurePending) return
                receivedFrames = true // Silence is still a successfully received audio frame.
                val packet = Packet(copy, StreamPcmFormat(rate, channels), frames.toDouble() / rate)
                while (queue.isNotEmpty() && queuedSeconds + packet.seconds > 0.100001) {
                    queuedSeconds -= queue.removeFirst().seconds
                }
                queue.addLast(packet)
                queuedSeconds += packet.seconds
                available.signal()
            }
        }

        private fun run() {
            var format: StreamPcmFormat? = null
            try {
                while (active && !failurePending) {
                    val packet = lock.withLock {
                        while (active && !failurePending && queue.isEmpty()) available.await()
                        if (!active || failurePending) return
                        queue.removeFirst().also { queuedSeconds -= it.seconds }
                    }
                    val bytes = applyStreamPcmGain(packet.bytes, gain)
                    var offset = 0
                    var idleWrites = 0
                    while (active && !failurePending && offset < bytes.size) {
                        val written = synchronized(outputLock) {
                            if (!active || failurePending) return
                            if (format != packet.format) {
                                releaseOutput()
                                output = outputFactory(packet.format)
                                format = packet.format
                                output!!.play()
                            }
                            output!!.write(bytes, offset, bytes.size - offset)
                        }
                        check(written in 0..(bytes.size - offset)) { "Media AudioTrack write failed: $written" }
                        if (written == 0) {
                            check(++idleWrites <= 125) { "Media AudioTrack stalled" }
                            Thread.sleep(2)
                        } else {
                            offset += written
                            idleWrites = 0
                            if (!reportedPlaying) {
                                reportedPlaying = true
                                report(StreamAudioStatus.PLAYING)
                            }
                        }
                    }
                }
            } catch (error: Exception) {
                if (active) fail(error)
            } finally {
                synchronized(outputLock) { releaseOutput() }
            }
        }

        fun close() {
            lock.withLock {
                active = false
                queue.clear(); queuedSeconds = 0.0
                available.signalAll()
            }
            // Writes are nonblocking, so stopping never waits for a full platform playback buffer.
            synchronized(outputLock) { releaseOutput() }
            runCatching { source.removeSink(this) }
            // Never restore default playback: screen audio must stay out of the voice mixer.
        }

        private fun releaseOutput() {
            val old = output; output = null
            if (old != null) runCatching { old.close() }.onFailure { Log.w(TAG, "Media output release failed", it) }
        }

        fun fail(error: Exception) {
            lock.withLock {
                if (!active || failurePending) return
                failurePending = true
                available.signalAll()
            }
            // Native callbacks only schedule teardown; removing a sink inside its callback can deadlock.
            mainHandler.post {
                if (binding !== this || !active) return@post
                mainHandler.removeCallbacks(noFrames)
                Log.w(TAG, "Stream audio playback failed", error)
                close()
                setStatus(StreamAudioStatus.FAILED)
            }
        }

        private fun report(status: StreamAudioStatus) {
            mainHandler.post { if (binding === this && active && !failurePending) setStatus(status) }
        }
    }

    private data class Packet(val bytes: ByteArray, val format: StreamPcmFormat, val seconds: Double)
    companion object { private const val TAG = "StreamAudio" }
}

/** Same 0..4 gain policy as voice, including boosts; PCM saturation prevents integer wraparound. */
internal fun applyStreamPcmGain(bytes: ByteArray, gain: Double): ByteArray {
    if (gain == 1.0) return bytes
    val pcm = ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder())
    val multiplier = gain.coerceIn(0.0, 4.0)
    for (offset in 0 until bytes.size - 1 step 2) {
        val value = (pcm.getShort(offset) * multiplier).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
        pcm.putShort(offset, value.toShort())
    }
    return bytes
}

internal fun streamAudioAvailability(
    visible: Boolean, connected: Boolean, videoAvailable: Boolean, videoMuted: Boolean,
    sound: Boolean, gain: Double, published: Boolean, allowed: Boolean, audioMuted: Boolean,
    subscriptionFailed: Boolean, subscribed: Boolean,
): StreamAudioStatus = when {
    !visible || !videoAvailable || videoMuted -> StreamAudioStatus.PAUSED
    !sound || gain <= 0 -> StreamAudioStatus.MUTED
    !connected -> StreamAudioStatus.CONNECTING
    !published -> StreamAudioStatus.NO_TRACK
    !allowed || subscriptionFailed -> StreamAudioStatus.UNAVAILABLE
    audioMuted -> StreamAudioStatus.MUTED
    !subscribed -> StreamAudioStatus.CONNECTING
    else -> StreamAudioStatus.PLAYING // Eligible for PCM playback; first successful write confirms playing.
}
