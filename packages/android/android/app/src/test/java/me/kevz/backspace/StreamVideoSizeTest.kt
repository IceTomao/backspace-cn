package me.kevz.backspace

import android.content.pm.ActivityInfo
import org.junit.Assert.*
import org.junit.Test

class StreamVideoSizeTest {
    @Test fun fitsLandscapePortraitAndUltrawideWithoutCropping() {
        assertEquals(StreamVideoSize(360, 203), StreamVideoSize(1920, 1080).fit(360, 640))
        assertEquals(StreamVideoSize(225, 400), StreamVideoSize(1080, 1920).fit(800, 400))
        assertEquals(StreamVideoSize(800, 225), StreamVideoSize(3840, 1080).fit(800, 400))
        assertEquals(StreamVideoSize(360, 360), StreamVideoSize(1000, 1000).fit(360, 640))
        assertEquals(StreamVideoSize(0, 0), StreamVideoSize(1920, 1080).fit(0, 640))
        assertEquals(StreamVideoSize(0, 0), StreamVideoSize(1920, 1080).fit(360, -1))
    }

    @Test fun usesRotatedFrameDimensionsAndIgnoresUnknownSizes() {
        assertNull(StreamVideoSize.fromFrame(0, 1080, 0))
        assertNull(StreamVideoSize.fromFrame(1920, -1, 0))
        assertEquals(StreamVideoSize(1920, 1080), StreamVideoSize.fromFrame(1920, 1080, 0))
        assertEquals(StreamVideoSize(1080, 1920), StreamVideoSize.fromFrame(1920, 1080, 90))
        assertEquals(StreamVideoSize(1920, 1080), StreamVideoSize.fromFrame(1920, 1080, 180))
        assertEquals(StreamVideoSize(1080, 1920), StreamVideoSize.fromFrame(1920, 1080, 270))
    }

    @Test fun orientationFollowsContentAndSquareKeepsTheCurrentDirection() {
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, StreamVideoSize(1920, 1080).fullscreenOrientation())
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, StreamVideoSize(1080, 1920).fullscreenOrientation())
        assertNull(StreamVideoSize(1000, 1000).fullscreenOrientation())
    }

    @Test fun fittedSizeAlwaysStaysInsideTheViewportWithAtMostOnePixelRoundingError() {
        for (video in listOf(StreamVideoSize(1920, 1080), StreamVideoSize(1080, 1920), StreamVideoSize(3840, 1080))) {
            for (bounds in listOf(StreamVideoSize(393, 650), StreamVideoSize(851, 290), StreamVideoSize(1200, 800))) {
                val fitted = video.fit(bounds.width, bounds.height)
                assertTrue(fitted.width in 1..bounds.width && fitted.height in 1..bounds.height)
                val error = kotlin.math.abs(fitted.width.toDouble() / video.width - fitted.height.toDouble() / video.height)
                assertTrue(error <= 1.0 / minOf(video.width, video.height))
                assertTrue(fitted.width == bounds.width || fitted.height == bounds.height)
            }
        }
    }
}
