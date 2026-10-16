package me.kevz.backspace

import io.livekit.android.room.track.Track

internal object StreamSubscriptionPolicy {
    const val HDR_TRACK_NAME = "backspace-screen-hdr-v1"
    fun subscribe(source: Track.Source, identity: String, target: String?, visible: Boolean, sound: Boolean, hdr: Boolean = false): Boolean =
        source == Track.Source.MICROPHONE || (!hdr && visible && identity == target &&
            (source == Track.Source.SCREEN_SHARE || (source == Track.Source.SCREEN_SHARE_AUDIO && sound)))

    fun volume(output: Double, member: Double, deafened: Boolean, memberMuted: Boolean): Double =
        if (deafened || memberMuted) 0.0 else (output * member / 10_000.0).coerceIn(0.0, 4.0)
}
