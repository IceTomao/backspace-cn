package me.kevz.backspace

import android.view.MotionEvent
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class StreamGestureViewTest {
    private fun view() = StreamGestureView(RuntimeEnvironment.getApplication()).apply { layout(0, 0, 400, 800) }
    private fun StreamGestureView.send(action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(0, 0, action, x, y, 0)
        try { dispatchTouchEvent(event) } finally { event.recycle() }
    }

    @Test fun tinyMovementRemainsATapAndHorizontalMovementDoesNotAdjustAnything() {
        val view = view()
        var clicks = 0
        var changes = 0
        view.setOnClickListener { clicks++ }
        view.onGestureChange = { _, _ -> changes++ }
        view.send(MotionEvent.ACTION_DOWN, 100f, 400f)
        view.send(MotionEvent.ACTION_MOVE, 101f, 401f)
        view.send(MotionEvent.ACTION_UP, 101f, 401f)
        assertEquals(1, clicks)
        view.send(MotionEvent.ACTION_DOWN, 100f, 400f)
        view.send(MotionEvent.ACTION_MOVE, 300f, 410f)
        view.send(MotionEvent.ACTION_MOVE, 300f, 200f)
        view.send(MotionEvent.ACTION_UP, 300f, 200f)
        assertEquals(1, clicks)
        assertEquals(0, changes)
    }

    @Test fun sideIsLockedAtTouchDownAndUpwardMovementIncreasesTheValue() {
        val view = view()
        val sides = mutableListOf<StreamGesture>()
        val changes = mutableListOf<Float>()
        view.onGestureChange = { side, change -> sides.add(side); changes.add(change) }
        view.send(MotionEvent.ACTION_DOWN, 100f, 600f)
        view.send(MotionEvent.ACTION_MOVE, 220f, 350f)
        view.send(MotionEvent.ACTION_MOVE, 300f, 200f)
        view.send(MotionEvent.ACTION_UP, 300f, 200f)
        assertTrue(sides.all { it == StreamGesture.BRIGHTNESS })
        assertEquals(400f / 480f, changes.last(), 0.001f)
        view.send(MotionEvent.ACTION_DOWN, 300f, 200f)
        view.send(MotionEvent.ACTION_MOVE, 100f, 600f)
        assertEquals(StreamGesture.VOLUME, sides.last())
        assertTrue(changes.last() < 0)
    }

    @Test fun cancellationAndAdditionalFingersStopAdjustmentWithoutGeneratingClicks() {
        val view = view()
        var changes = 0
        var ends = 0
        var clicks = 0
        view.onGestureChange = { _, _ -> changes++ }
        view.onGestureEnd = { ends++ }
        view.setOnClickListener { clicks++ }
        for (cancel in listOf(MotionEvent.ACTION_CANCEL, MotionEvent.ACTION_POINTER_DOWN)) {
            view.send(MotionEvent.ACTION_DOWN, 100f, 600f)
            view.send(MotionEvent.ACTION_MOVE, 100f, 400f)
            val before = changes
            view.send(cancel, 100f, 400f)
            view.send(MotionEvent.ACTION_MOVE, 100f, 200f)
            view.send(MotionEvent.ACTION_UP, 100f, 200f)
            assertEquals(before, changes)
        }
        assertEquals(2, ends)
        assertEquals(0, clicks)
    }

    @Test fun disabledGesturesStillAllowTappingAndSensitivityScalesWithPlayerHeight() {
        val view = view()
        var clicks = 0
        var change = 0f
        view.setOnClickListener { clicks++ }
        view.onGestureChange = { _, value -> change = value }
        view.allowGesture = { _, _ -> false }
        view.send(MotionEvent.ACTION_DOWN, 100f, 400f)
        view.send(MotionEvent.ACTION_UP, 100f, 400f)
        assertEquals(1, clicks)
        view.send(MotionEvent.ACTION_DOWN, 100f, 600f)
        view.send(MotionEvent.ACTION_MOVE, 100f, 200f)
        view.send(MotionEvent.ACTION_UP, 100f, 200f)
        assertEquals(0f, change, 0f)
        view.allowGesture = { _, _ -> true }
        for (height in listOf(800, 300)) {
            view.layout(0, 0, 400, height)
            view.send(MotionEvent.ACTION_DOWN, 300f, height * 0.7f)
            view.send(MotionEvent.ACTION_MOVE, 300f, height * 0.4f)
            view.send(MotionEvent.ACTION_UP, 300f, height * 0.4f)
            assertEquals(0.5f, change, 0.001f)
        }
    }
}
