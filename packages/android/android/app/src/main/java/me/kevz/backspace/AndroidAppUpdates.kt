package me.kevz.backspace

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject

internal data class AndroidRelease(val version: String, val versionCode: Long) {
    val downloadUrl get() = "https://github.com/IceTomao/backspace-cn/releases/download/android-v$version/Backspace-CN-$version-android.apk"
}

internal object AndroidReleasePolicy {
    fun version(value: String): AndroidRelease? {
        if (!Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(value)) return null
        val parts = value.split('.').map { it.toLongOrNull() ?: return null }
        if (parts[0] > 2146 || parts[1] >= 1000 || parts[2] >= 1000) return null
        val code = parts[0] * 1_000_000 + parts[1] * 1000 + parts[2]
        return AndroidRelease(value, code).takeIf { code in 1..Int.MAX_VALUE.toLong() }
    }

    fun latest(releases: JSONArray): AndroidRelease? = (0 until releases.length()).mapNotNull { index ->
        val release = releases.optJSONObject(index) ?: return@mapNotNull null
        if (release.optBoolean("draft") || release.optBoolean("prerelease")) return@mapNotNull null
        val tag = release.optString("tag_name")
        if (!tag.startsWith("android-v")) return@mapNotNull null
        val candidate = version(tag.removePrefix("android-v")) ?: return@mapNotNull null
        val assets = release.optJSONArray("assets") ?: return@mapNotNull null
        val apk = (0 until assets.length()).mapNotNull { assets.optJSONObject(it) }.firstOrNull {
            it.optString("name") == "Backspace-CN-${candidate.version}-android.apk" &&
                it.optString("state") == "uploaded" && it.optLong("size") > 0 &&
                it.optString("browser_download_url") == candidate.downloadUrl
        }
        candidate.takeIf { apk != null }
    }.maxByOrNull { it.versionCode }
}

internal class AndroidAppUpdates(
    private val currentVersion: String,
    private val currentCode: Long,
    private val supported: Boolean,
    private val preferences: SharedPreferences,
    private val scope: CoroutineScope,
    private val loadReleases: () -> JSONArray,
    private val emit: (JSONObject) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    companion object {
        const val RELEASES_URL = "https://api.github.com/repos/IceTomao/backspace-cn/releases?per_page=100"
        const val CHECK_INTERVAL = 24 * 60 * 60 * 1000L
        const val FAILURE_INTERVAL = 6 * 60 * 60 * 1000L
        @Suppress("DEPRECATION")
        fun installed(context: Context): Pair<String, Long> {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            return (info.versionName ?: "unknown") to info.longVersionCode
        }
    }

    private var latest = preferences.getString("latestVersion", null)?.let(AndroidReleasePolicy::version)
    private var phase = if (!supported) "unsupported" else when (preferences.getString("phase", "idle")) {
        "available", "up-to-date" -> if (latest == null) "idle" else availablePhase()
        "failed" -> "failed"
        "unavailable" -> "unavailable"
        else -> "idle"
    }
    private var inFlight: Deferred<JSONObject>? = null
    private fun availablePhase() = if ((latest?.versionCode ?: 0) > currentCode) "available" else "up-to-date"

    fun snapshot(): JSONObject = JSONObject().put("currentVersion", currentVersion).put("phase", phase)
        .put("version", latest?.version ?: JSONObject.NULL)
        .put("dismissedVersion", preferences.getString("dismissedVersion", null) ?: JSONObject.NULL)

    fun dismiss(): JSONObject {
        latest?.let { preferences.edit().putString("dismissedVersion", it.version).apply() }
        return snapshot().also(emit)
    }

    fun downloadUrl(): String {
        check(supported && phase == "available" && latest != null) { "请先检查可用更新" }
        return latest!!.downloadUrl
    }

    suspend fun check(manual: Boolean): JSONObject {
        if (!supported) return snapshot()
        inFlight?.let { return it.await() }
        val elapsed = clock() - preferences.getLong("lastAttempt", 0)
        val interval = if (phase == "failed") FAILURE_INTERVAL else CHECK_INTERVAL
        if (!manual && preferences.contains("lastAttempt") && elapsed in 0 until interval) return snapshot()
        val job = scope.async(start = CoroutineStart.LAZY) {
            phase = "checking"
            emit(snapshot())
            preferences.edit().putLong("lastAttempt", clock()).apply()
            try {
                latest = withContext(io) { AndroidReleasePolicy.latest(loadReleases()) }
                phase = if (latest == null) "unavailable" else availablePhase()
                preferences.edit().putString("latestVersion", latest?.version).putString("phase", phase).apply()
            } catch (error: CancellationException) {
                phase = "idle"
                throw error
            } catch (_: Exception) {
                phase = "failed"
                preferences.edit().putString("phase", phase).apply()
            }
            snapshot().also(emit)
        }
        inFlight = job
        return try { job.start(); job.await() } finally { if (inFlight === job) inFlight = null }
    }
}
