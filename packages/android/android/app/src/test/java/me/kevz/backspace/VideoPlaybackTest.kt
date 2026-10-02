package me.kevz.backspace

import org.junit.Assert.*
import org.junit.Test

class VideoPlaybackTest {
    @Test fun acceptsOnlyConnectedHttpsAttachmentOriginsAndRejectsEscapes() {
        val allowed = setOf("https://home.example:2096", "https://peer.example:8443")
        assertEquals("https://peer.example:8443", VideoUrlPolicy.origin("https://peer.example:8443/api/uploads/clip.mp4", allowed))
        assertEquals("https://home.example:2096", VideoUrlPolicy.origin("https://home.example:2096/api/uploads/clip.mp4?download=1", allowed))
        for (url in listOf("http://home.example:2096/api/uploads/clip.mp4", "https://unknown.example/api/uploads/clip.mp4",
            "https://user@home.example:2096/api/uploads/clip.mp4", "https://home.example:2096/api/private",
            "https://home.example:2096/api/uploads/../private", "https://home.example:2096/api/uploads/%2fprivate",
            "https://home.example:2096/api/uploads/%2e%2e", "file:///sdcard/clip.mp4", "https://home.example:2096/api/uploads/")) {
            assertTrue(url, runCatching { VideoUrlPolicy.origin(url, allowed) }.isFailure)
        }
    }
    @Test fun releasesOnStopPreservesPositionAndMuteAndWaitsForUserAfterBackground() {
        val session = VideoPlaybackSession("https://home.example/api/uploads/clip.mp4", "clip", "video/mp4", "https://home.example")
        val engines = mutableListOf<FakeVideoEngine>()
        val controller = VideoPlaybackController(session) { FakeVideoEngine().also(engines::add) }
        controller.start(); controller.start()
        assertEquals(1, engines.size); assertTrue(engines[0].play)
        engines[0].positionMs = 6500L
        controller.toggleMute(); assertTrue(engines[0].muted)
        controller.stop(); controller.stop()
        assertEquals(1, engines[0].releases); assertNull(controller.engine)
        controller.start()
        assertEquals(6500L, engines[1].preparedPosition); assertFalse(engines[1].play); assertTrue(engines[1].muted)
        controller.retry()
        assertEquals(1, engines[1].releases); assertTrue(engines[2].play)
        controller.stop(); assertEquals(1, engines[2].releases)
    }
}

internal class FakeVideoEngine : VideoEngine {
    override var positionMs = 0L
    var preparedPosition = 0L
    var play = false
    var muted = false
    var releases = 0
    override fun prepare(positionMs: Long, play: Boolean, muted: Boolean) {
        this.positionMs = positionMs; preparedPosition = positionMs; this.play = play; this.muted = muted
    }
    override fun mute(muted: Boolean) { this.muted = muted }
    override fun release() { releases++ }
}
