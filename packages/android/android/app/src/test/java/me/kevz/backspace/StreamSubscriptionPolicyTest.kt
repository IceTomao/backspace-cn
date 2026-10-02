package me.kevz.backspace

import io.livekit.android.room.track.Track
import org.junit.Assert.*
import org.junit.Test

class StreamSubscriptionPolicyTest {
    @Test fun onlySelectedScreenAndSoundAreReceivedAlongsideChannelVoice() {
        assertTrue(StreamSubscriptionPolicy.subscribe(Track.Source.MICROPHONE, "other", "target", false, false))
        assertTrue(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE, "target", "target", true, true))
        assertTrue(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE_AUDIO, "target", "target", true, true))
        assertFalse(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE, "other", "target", true, true))
        assertFalse(StreamSubscriptionPolicy.subscribe(Track.Source.CAMERA, "target", "target", true, true))
    }
    @Test fun backgroundAndStopReleaseStreamSubscriptionsWhileSoundToggleKeepsVideo() {
        assertFalse(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE, "target", "target", false, true))
        assertFalse(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE_AUDIO, "target", "target", false, true))
        assertFalse(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE, "target", null, true, true))
        assertFalse(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE_AUDIO, "target", "target", true, false))
        assertTrue(StreamSubscriptionPolicy.subscribe(Track.Source.SCREEN_SHARE, "target", "target", true, false))
    }
    @Test fun streamAudioUsesMemberVolumeAndRespectsMuteAndDeafen() {
        assertEquals(0.25, StreamSubscriptionPolicy.volume(50.0, 50.0, false, false), 0.001)
        assertEquals(0.0, StreamSubscriptionPolicy.volume(100.0, 100.0, true, false), 0.001)
        assertEquals(0.0, StreamSubscriptionPolicy.volume(100.0, 100.0, false, true), 0.001)
    }
    @Test fun reconnectBackoffGrowsAndNeverExceedsThirtySeconds() {
        assertEquals(800, reconnectDelay(0, 0.0).toInt())
        assertEquals(2000, reconnectDelay(1, 1.0).toInt())
        assertEquals(30_000, reconnectDelay(100, 1.0).toInt())
        assertTrue(reconnectDelay(5, 0.5) in 24_000..30_000)
    }
}
