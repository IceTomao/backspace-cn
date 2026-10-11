package me.kevz.backspace

import android.os.Looper
import android.media.AudioAttributes
import android.media.AudioManager
import livekit.org.webrtc.AudioTrackSink
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
@LooperMode(LooperMode.Mode.PAUSED)
class StreamAudioPlaybackTest {
    private val statuses = mutableListOf<StreamAudioStatus>()
    private val outputs = CopyOnWriteArrayList<FakePcmOutput>()
    private var controller: StreamAudioPlayback? = null
    private fun create(factory: (StreamPcmFormat) -> StreamPcmOutput = { FakePcmOutput(it).also(outputs::add) }): StreamAudioPlayback {
        return StreamAudioPlayback(outputFactory = factory, onStatus = statuses::add).also { controller = it }
    }
    @After fun cleanup() { controller?.stop(); shadowOf(Looper.getMainLooper()).idle() }

    @Test fun decodedPcmIsCopiedAndPlayedOnlyOnceWhileDefaultVoiceMixIsSilenced() {
        val source = FakeAudioSource()
        val playback = create()
        playback.update(source, 0.5)
        assertEquals(0.0, source.defaultGain, 0.0)
        assertEquals(listOf("silence", "attach"), source.operations)
        val data = pcm(1000, -1000)
        source.sink!!.onData(data, 16, 48_000, 2, 1, 0)
        assertEquals(0, data.position())
        data.putShort(0, 32000) // The native callback buffer may be reused immediately.
        await { outputs.firstOrNull()?.samples()?.size == 2 }
        assertEquals(listOf(500, -500), outputs.single().samples())
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamAudioStatus.PLAYING, playback.status)
        playback.update(source, 1.0)
        assertEquals(1, source.attaches)
        source.sink!!.onData(pcm(2000, -2000), 16, 48_000, 2, 1, 0)
        await { outputs.single().samples().size == 4 }
        assertEquals(listOf(2000, -2000), outputs.single().samples().takeLast(2))
    }

    @Test fun silenceIsValidAudioAndFormatChangesRecreateOnlyTheMediaOutput() {
        val source = FakeAudioSource()
        create().update(source, 1.0)
        source.send(0, rate = 48_000)
        await { outputs.firstOrNull()?.samples()?.size == 1 }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamAudioStatus.PLAYING, controller!!.status)
        source.send(0, rate = 44_100)
        await { outputs.size == 2 && outputs[1].samples().size == 1 }
        assertTrue(outputs[0].closed)
        assertEquals(StreamPcmFormat(44_100, 1), outputs[1].format)
        assertEquals(1, source.attaches)
    }

    @Test fun stopAndSourceReplacementDiscardOldPcmAndStaleStateCallbacks() {
        val first = FakeAudioSource()
        val second = FakeAudioSource()
        val playback = create()
        playback.update(first, 1.0)
        val oldSink = first.sink!!
        first.send(100)
        await { outputs.firstOrNull()?.samples()?.size == 1 }
        // A pending first-binding PLAYING callback must not affect the second binding.
        playback.update(second, 1.0)
        assertTrue(outputs[0].closed)
        assertNull(first.sink)
        oldSink.onData(pcm(999), 16, 48_000, 1, 1, 0)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamAudioStatus.CONNECTING, playback.status)
        second.send(200)
        await { outputs.size == 2 && outputs[1].samples().size == 1 }
        assertEquals(listOf(100), outputs[0].samples())
        assertEquals(listOf(200), outputs[1].samples())
        val secondSink = second.sink!!
        playback.stop()
        secondSink.onData(pcm(999), 16, 48_000, 1, 1, 0)
        assertTrue(outputs[1].closed)
        assertEquals(listOf(200), outputs[1].samples())
        assertNull(second.sink)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamAudioStatus.PAUSED, playback.status)
        assertEquals(0.0, first.defaultGain, 0.0)
        assertEquals(0.0, second.defaultGain, 0.0)
    }

    @Test fun boundedQueueDropsOldAudioRatherThanAccumulatingPlaybackDelay() {
        val writable = AtomicBoolean(false)
        val entered = CountDownLatch(1)
        val playback = create { format -> FakePcmOutput(format, writable = writable, entered = entered).also(outputs::add) }
        val source = FakeAudioSource()
        playback.update(source, 1.0)
        source.send(1, frames = 480) // 10ms, currently held by the writer.
        assertTrue(entered.await(3, TimeUnit.SECONDS))
        for (value in 2..31) source.send(value, frames = 480)
        writable.set(true)
        await { outputs.single().chunks.size == 11 }
        assertEquals(listOf(1) + (22..31).toList(), outputs.single().chunks.map { it.first().toInt() })
    }

    @Test fun partialWritesPreserveEverySampleAndBoostsSaturateInsteadOfWrapping() {
        val source = FakeAudioSource()
        create { format -> FakePcmOutput(format, maxWrite = 2).also(outputs::add) }.update(source, 4.0)
        source.sink!!.onData(pcm(20000, -20000, 1, -1), 16, 48_000, 1, 4, 0)
        await { outputs.firstOrNull()?.samples()?.size == 4 }
        assertEquals(listOf(32767, -32768, 4, -4), outputs.single().samples())
    }

    @Test fun platformWriteFailureReleasesOutputAndRequiresANewBindingToRetry() {
        val source = FakeAudioSource()
        create { format -> FakePcmOutput(format, failure = true).also(outputs::add) }.update(source, 1.0)
        source.send(1)
        await { outputs.firstOrNull()?.closed == true }
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamAudioStatus.FAILED, controller!!.status)
        assertNull(source.sink)
        controller!!.update(source, 1.0)
        assertEquals(StreamAudioStatus.FAILED, controller!!.status)
        controller!!.stop()
        controller!!.update(source, 1.0)
        assertEquals(StreamAudioStatus.CONNECTING, controller!!.status)
        assertEquals(2, source.attaches)
    }

    @Test fun invalidPcmAndInitializationFailureNeverFallBackToVoicePlayback() {
        val source = FakeAudioSource()
        create { error("AudioTrack unavailable") }.update(source, 1.0)
        source.send(1)
        await { shadowOf(Looper.getMainLooper()).idle(); controller!!.status == StreamAudioStatus.FAILED }
        assertEquals(0.0, source.defaultGain, 0.0)
        controller!!.stop()
        controller!!.update(source, 1.0)
        source.sink!!.onData(pcm(1), 32, 48_000, 1, 1, 0)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(StreamAudioStatus.FAILED, controller!!.status)
        assertNull(source.sink)
    }

    @Test fun subscriptionAvailabilityCoversLatePublicationRecoveryAndIndependentMuteRules() {
        fun state(published: Boolean = true, subscribed: Boolean = true, visible: Boolean = true,
                  sound: Boolean = true, connected: Boolean = true, failed: Boolean = false,
                  allowed: Boolean = true, gain: Double = 1.0, video: Boolean = true, muted: Boolean = false) =
            streamAudioAvailability(visible, connected, video, false, sound, gain, published, allowed, muted, failed, subscribed)
        assertEquals(StreamAudioStatus.NO_TRACK, state(published = false))
        assertEquals(StreamAudioStatus.CONNECTING, state(subscribed = false))
        assertEquals(StreamAudioStatus.PLAYING, state())
        assertEquals(StreamAudioStatus.UNAVAILABLE, state(failed = true))
        assertEquals(StreamAudioStatus.UNAVAILABLE, state(allowed = false))
        assertEquals(StreamAudioStatus.CONNECTING, state(connected = false))
        assertEquals(StreamAudioStatus.PAUSED, state(visible = false))
        assertEquals(StreamAudioStatus.PAUSED, state(video = false))
        assertEquals(StreamAudioStatus.MUTED, state(sound = false))
        assertEquals(StreamAudioStatus.MUTED, state(gain = 0.0))
        assertEquals(StreamAudioStatus.MUTED, state(muted = true))
        assertEquals(StreamAudioStatus.PLAYING, state())
    }

    @Test fun zeroGainProducesDigitalSilence() {
        val bytes = ByteArray(4).also { ByteBuffer.wrap(it).order(ByteOrder.nativeOrder()).putShort(32767).putShort(-32768) }
        assertArrayEquals(ByteArray(4), applyStreamPcmGain(bytes, 0.0))
    }

    @Test fun platformOutputUsesMediaAttributesWithoutChangingCommunicationModeOrFocus() {
        val audio = RuntimeEnvironment.getApplication().getSystemService(AudioManager::class.java)
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        val focus = shadowOf(audio).lastAudioFocusRequest
        val output = AndroidStreamPcmOutput(StreamPcmFormat(48_000, 2))
        try {
            assertEquals(AudioAttributes.USAGE_MEDIA, output.track.audioAttributes.usage)
            assertEquals(48_000, output.track.sampleRate)
            assertEquals(2, output.track.channelCount)
            output.play()
            assertEquals(4, output.write(byteArrayOf(0, 0, 0, 0), 0, 4))
            assertEquals(AudioManager.MODE_IN_COMMUNICATION, audio.mode)
            assertSame(focus, shadowOf(audio).lastAudioFocusRequest)
        } finally { output.close() }
    }

    private fun pcm(vararg values: Int): ByteBuffer = ByteBuffer.allocate(values.size * 2).order(ByteOrder.nativeOrder()).apply {
        values.forEach { putShort(it.toShort()) }; flip()
    }
    private fun await(predicate: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
        while (!predicate() && System.nanoTime() < deadline) Thread.sleep(2)
        assertTrue("Playback worker did not reach the expected state", predicate())
    }
}

private class FakeAudioSource : StreamAudioSource {
    override val key: Any = Any()
    var sink: AudioTrackSink? = null
    var defaultGain = 1.0
    var attaches = 0
    val operations = mutableListOf<String>()
    override fun silenceDefaultPlayback() { defaultGain = 0.0; operations.add("silence") }
    override fun addSink(sink: AudioTrackSink) { this.sink = sink; attaches++; operations.add("attach") }
    override fun removeSink(sink: AudioTrackSink) { if (this.sink === sink) this.sink = null; operations.add("detach") }
    fun send(value: Int, rate: Int = 48_000, frames: Int = 1) {
        val data = ByteBuffer.allocate(frames * 2).order(ByteOrder.nativeOrder())
        repeat(frames) { data.putShort(value.toShort()) }
        data.flip()
        sink?.onData(data, 16, rate, 1, frames, 0)
    }
}

private class FakePcmOutput(
    val format: StreamPcmFormat, val maxWrite: Int = Int.MAX_VALUE,
    val writable: AtomicBoolean = AtomicBoolean(true), val entered: CountDownLatch = CountDownLatch(0),
    val failure: Boolean = false,
) : StreamPcmOutput {
    val chunks = CopyOnWriteArrayList<List<Short>>()
    @Volatile var closed = false
    override fun play() {}
    override fun write(bytes: ByteArray, offset: Int, length: Int): Int {
        entered.countDown()
        if (failure) return -6
        if (!writable.get()) return 0
        val count = minOf(length, maxWrite)
        val data = ByteBuffer.wrap(bytes, offset, count).order(ByteOrder.nativeOrder())
        val samples = mutableListOf<Short>()
        while (data.remaining() >= 2) samples.add(data.short)
        chunks.add(samples)
        return count
    }
    override fun close() { closed = true }
    fun samples() = chunks.flatMap { it }.map { it.toInt() }
}
