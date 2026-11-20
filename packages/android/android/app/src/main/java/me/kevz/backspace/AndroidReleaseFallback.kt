package me.kevz.backspace

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

/**
 * Release discovery that does not depend on `api.github.com`.
 *
 * The GitHub REST API is rate limited per IP for unauthenticated callers and is
 * filtered out on some networks, which surfaced as an unexplained "update check
 * failed" on devices that can reach github.com perfectly well. The public Atom
 * feed of the repository lives on the same host users already download the APK
 * from, so it keeps working when the API does not.
 *
 * The feed only carries tag names, so the APK is verified with a HEAD request
 * against the exact release URL the update policy expects. The synthesized
 * payload mirrors the REST shape so [AndroidReleasePolicy] stays the single
 * source of truth for what counts as a publishable Android release.
 */
internal object AndroidReleaseFallback {
    const val FEED_URL = "https://github.com/IceTomao/backspace-cn/releases.atom"

    /** Only the newest tags are worth verifying; the policy picks the highest. */
    private const val MAX_TAGS = 10

    private val TAG_LINK = Regex(
        """https://github\.com/IceTomao/backspace-cn/releases/tag/(android-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))""",
    )

    fun load(http: OkHttpClient, userAgent: String): JSONArray {
        val feed = http.newCall(
            Request.Builder().url(FEED_URL)
                .header("Accept", "application/atom+xml")
                .header("User-Agent", userAgent)
                .build(),
        ).execute().use { response ->
            check(response.isSuccessful) { "Release feed failed with HTTP ${response.code}" }
            response.body?.string() ?: error("Empty release feed")
        }

        val releases = JSONArray()
        TAG_LINK.findAll(feed)
            .map { match -> match.groupValues[1] }
            .distinct()
            .take(MAX_TAGS)
            .forEach { tag ->
                val version = tag.removePrefix("android-v")
                val candidate = AndroidReleasePolicy.version(version) ?: return@forEach
                val size = apkSize(http, candidate.downloadUrl) ?: return@forEach
                releases.put(
                    JSONObject()
                        .put("tag_name", tag)
                        .put("draft", false)
                        .put("prerelease", false)
                        .put("assets", JSONArray().put(
                            JSONObject()
                                .put("name", "Backspace-CN-$version-android.apk")
                                .put("state", "uploaded")
                                .put("size", size)
                                .put("browser_download_url", candidate.downloadUrl),
                        )),
                )
            }
        return releases
    }

    /**
     * Returns the APK size, or null when the asset is missing. Release downloads
     * redirect to `objects.githubusercontent.com`, so the probe follows
     * redirects even when the shared client is configured not to.
     */
    private fun apkSize(http: OkHttpClient, url: String): Long? = runCatching {
        http.newBuilder().followRedirects(true).build()
            .newCall(Request.Builder().url(url).head().build())
            .execute().use { response ->
                if (!response.isSuccessful) return@use null
                response.body?.contentLength()?.takeIf { it > 0 }
            }
    }.getOrNull()
}
