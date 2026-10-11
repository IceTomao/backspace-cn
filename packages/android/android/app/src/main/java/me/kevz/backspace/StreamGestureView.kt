package me.kevz.backspace

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import kotlin.math.abs

internal enum class StreamGesture { BRIGHTNESS, VOLUME }

/** A transparent video-only touch surface; the Activity's chrome remains above it. */
internal class StreamGestureView(context: Context) : View(context) {
    var allowGesture: (Float, Float) -> Boolean = { _, _ -> true }
    var onGestureStart: (StreamGesture) -> Unit = {}
    var onGestureChange: (StreamGesture, Float) -> Unit = { _, _ -> }
    var onGestureEnd: () -> Unit = {}
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var startX = 0f
    private var startY = 0f
    private var distance = 1f
    private var side = StreamGesture.BRIGHTNESS
    private var active = false
    private var pending = false
    private var tap = false

    init {
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                cancelGesture()
                startX = event.x; startY = event.y
                distance = (height * 0.6f).coerceAtLeast(1f)
                side = if (startX < width / 2f) StreamGesture.BRIGHTNESS else StreamGesture.VOLUME
                pending = allowGesture(startX, startY)
                tap = true
            }
            MotionEvent.ACTION_MOVE -> {
                if (event.pointerCount != 1) { cancelGesture(); return true }
                val dx = abs(event.x - startX)
                val dy = abs(event.y - startY)
                if (dx > slop || dy > slop) tap = false
                if (pending && !tap) {
                    pending = false
                    if (dy > dx) {
                        active = true
                        parent?.requestDisallowInterceptTouchEvent(true)
                        onGestureStart(side)
                    }
                }
                if (active) onGestureChange(side, (startY - event.y) / distance)
            }
            MotionEvent.ACTION_UP -> {
                val click = tap && abs(event.x - startX) <= slop && abs(event.y - startY) <= slop
                if (active) onGestureChange(side, (startY - event.y) / distance)
                cancelGesture()
                if (click) performClick()
            }
            MotionEvent.ACTION_CANCEL, MotionEvent.ACTION_POINTER_DOWN -> cancelGesture()
        }
        return true
    }

    fun cancelGesture() {
        val wasActive = active
        active = false; pending = false; tap = false
        parent?.requestDisallowInterceptTouchEvent(false)
        if (wasActive) onGestureEnd()
    }

    override fun performClick(): Boolean = super.performClick()
}
