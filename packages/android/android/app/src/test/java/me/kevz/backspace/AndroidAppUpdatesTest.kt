package me.kevz.backspace

import android.content.Context
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
@OptIn(ExperimentalCoroutinesApi::class)
class AndroidAppUpdatesTest {
    private val preferences get() = RuntimeEnvironment.getApplication().getSharedPreferences("updatesTest", Context.MODE_PRIVATE)
    @Before fun clear() { preferences.edit().clear().commit() }

    private fun release(version: String, draft: Boolean = false, prerelease: Boolean = false): JSONObject {
        val candidate = AndroidReleasePolicy.version(version)!!
        return JSONObject().put("tag_name", "android-v$version").put("draft", draft).put("prerelease", prerelease)
            .put("assets", JSONArray().put(JSONObject().put("name", "Backspace-CN-$version-android.apk")
                .put("state", "uploaded").put("size", 40_000_000).put("browser_download_url", candidate.downloadUrl)))
    }

    @Test fun selectsNewestAndroidApkByNumericVersionAndIgnoresWindowsAndUnfinishedReleases() {
        val values = JSONArray().put(release("1.3.2")).put(release("1.3.10"))
            .put(release("9.0.0", draft = true)).put(release("8.0.0", prerelease = true))
            .put(JSONObject().put("tag_name", "v10.0.0").put("assets", JSONArray()))
        assertEquals("1.3.10", AndroidReleasePolicy.latest(values)?.version)
        assertEquals(1_003_010L, AndroidReleasePolicy.latest(values)?.versionCode)
    }

    @Test fun rejectsSpoofedDownloadsMissingApksAndInvalidVersions() {
        val invalid = release("1.3.22")
        invalid.getJSONArray("assets").getJSONObject(0).put("browser_download_url", "https://evil.example/update.apk")
        assertNull(AndroidReleasePolicy.latest(JSONArray().put(invalid)))
        assertNull(AndroidReleasePolicy.latest(JSONArray().put(release("1.3.22").put("assets", JSONArray()))))
        assertNull(AndroidReleasePolicy.latest(JSONArray().put(release("1.3.22").also {
            it.getJSONArray("assets").getJSONObject(0).put("state", "new")
        })))
        listOf("1.3.22-beta", "01.3.22", "1.1000.0", "1.0.1000", "99999999999999999.1.1").forEach {
            assertNull(AndroidReleasePolicy.version(it))
        }
    }

    @Test fun automaticChecksAreDailyManualChecksBypassThrottleAndDismissalSurvivesRestart() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var now = 1_000_000L
        var requests = 0
        val phases = mutableListOf<String>()
        fun create() = AndroidAppUpdates("1.3.21", 1_003_021, true, preferences, backgroundScope,
            { requests++; JSONArray().put(release("1.3.22")) }, { phases.add(it.getString("phase")) }, { now }, dispatcher)
        val checker = create()
        assertEquals("available", checker.check(false).getString("phase"))
        assertEquals(listOf("checking", "available"), phases)
        assertTrue(checker.downloadUrl().endsWith("Backspace-CN-1.3.22-android.apk"))
        checker.check(false)
        assertEquals(1, requests)
        checker.dismiss()
        assertEquals("1.3.22", create().snapshot().getString("dismissedVersion"))
        create().check(false)
        assertEquals(1, requests)
        now += AndroidAppUpdates.CHECK_INTERVAL
        checker.check(false)
        checker.check(true)
        assertEquals(3, requests)
    }

    @Test fun equalAndOlderReleasesNeverOfferDowngradesAndDebugBuildsDoNotReplaceTheOfficialApp() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val checker = AndroidAppUpdates("1.3.22", 1_003_022, true, preferences, backgroundScope,
            { JSONArray().put(release("1.3.22")).put(release("1.3.21")) }, {}, io = dispatcher)
        assertEquals("up-to-date", checker.check(true).getString("phase"))
        assertTrue(runCatching { checker.downloadUrl() }.isFailure)
        val debug = AndroidAppUpdates("1.3.22-debug", 1_003_022, false, preferences, backgroundScope,
            { error("Debug build must not fetch updates") }, {}, io = dispatcher)
        assertEquals("unsupported", debug.check(true).getString("phase"))
        assertTrue(runCatching { debug.downloadUrl() }.isFailure)
    }

    @Test fun failuresRemainFailuresAndAutomaticRetryWaitsSixHours() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var now = 1_000_000L
        var requests = 0
        val checker = AndroidAppUpdates("1.3.21", 1_003_021, true, preferences, backgroundScope,
            { requests++; throw java.io.IOException("offline") }, {}, { now }, dispatcher)
        assertEquals("failed", checker.check(false).getString("phase"))
        checker.check(false)
        assertEquals(1, requests)
        now += AndroidAppUpdates.FAILURE_INTERVAL
        checker.check(false)
        assertEquals(2, requests)
        checker.check(true)
        assertEquals(3, requests)
    }

    @Test fun concurrentRequestsShareOneCheckAndNoPublishedApkIsNotReportedAsUpToDate() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var requests = 0
        val checker = AndroidAppUpdates("1.3.21", 1_003_021, true, preferences, backgroundScope,
            { requests++; JSONArray() }, {}, io = dispatcher)
        val first = async { checker.check(true) }
        val second = async { checker.check(true) }
        assertEquals("unavailable", first.await().getString("phase"))
        assertEquals("unavailable", second.await().getString("phase"))
        assertEquals(1, requests)
    }
}
