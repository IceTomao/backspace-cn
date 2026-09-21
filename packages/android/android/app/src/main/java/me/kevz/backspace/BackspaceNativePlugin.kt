package me.kevz.backspace

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.getcapacitor.annotation.ActivityCallback
import androidx.activity.result.ActivityResult
import kotlinx.coroutines.launch
import org.json.JSONObject

@CapacitorPlugin(name = "BackspaceNative", permissions = [
    Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_CONNECT])
])
class BackspaceNativePlugin : Plugin() {
    private val runtime get() = BackspaceRuntime.get(context)
    private var relay: ((String, JSONObject) -> Unit)? = null

    override fun load() {
        relay = { event, value -> notifyListeners(event, JSObject(value.toString())) }
        runtime.emit = relay
    }
    override fun handleOnDestroy() {
        if (runtime.emit === relay) runtime.emit = null
        relay = null
    }
    override fun shouldOverrideLoad(url: Uri): Boolean? {
        if (url.scheme == "https" && url.host == "localhost" && url.port == -1) return false
        if (url.scheme in setOf("https", "http", "mailto")) {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, url)) }
        }
        return true
    }
    @PluginMethod
    fun execute(call: PluginCall) {
        activity.runOnUiThread {
            if (!ClientPolicy.bundledPage(bridge.webView.url ?: "")) {
                call.reject("仅允许内置页面调用"); return@runOnUiThread
            }
            val action = call.getString("action") ?: ""
            val data = call.getObject("data") ?: JSObject()
            if (action in setOf("joinVoice", "prepareVoice", "startCall", "acceptCall") && !runtime.foreground) {
                call.reject("请打开应用后加入语音"); return@runOnUiThread
            }
            if (action in setOf("joinVoice", "prepareVoice", "startCall", "acceptCall") &&
                getPermissionState("microphone") != PermissionState.GRANTED) {
                if (!runtime.foreground) { call.reject("请打开应用后加入语音"); return@runOnUiThread }
                requestPermissionForAlias("microphone", call, "microphoneResult")
                return@runOnUiThread
            }
            if (((action == "preferences" && data.optBoolean("background")) ||
                action in setOf("joinVoice", "startCall", "acceptCall")) &&
                Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "notificationResult")
                return@runOnUiThread
            }
            if (action == "bluetooth" && getPermissionState("bluetooth") != PermissionState.GRANTED) {
                requestPermissionForAlias("bluetooth", call, "bluetoothResult")
                return@runOnUiThread
            }
            if (action == "saveFile") {
                try {
                    runtime.validateDownload(data.getString("url") ?: "")
                    val name = (data.getString("name") ?: "附件").replace(Regex("[/\\\\\\p{Cntrl}]"), "_").take(160)
                    startActivityForResult(call, Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE).setType("application/octet-stream")
                        .putExtra(Intent.EXTRA_TITLE, name), "fileSelected")
                } catch (error: Exception) { call.reject(error.message ?: "无法保存附件") }
                return@runOnUiThread
            }
            dispatch(call)
        }
    }
    @PermissionCallback
    private fun microphoneResult(call: PluginCall) {
        if (!ClientPolicy.microphoneAllowed(runtime.foreground, getPermissionState("microphone") == PermissionState.GRANTED))
            call.reject("无法开始语音，请在前台授予麦克风权限")
        else execute(call)
    }
    @PermissionCallback
    private fun notificationResult(call: PluginCall) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) call.reject("通知权限被拒绝，未开启通话或后台在线")
        else execute(call)
    }
    @PermissionCallback
    private fun bluetoothResult(call: PluginCall) {
        if (getPermissionState("bluetooth") != PermissionState.GRANTED) call.reject("蓝牙权限被拒绝")
        else execute(call)
    }
    @ActivityCallback
    private fun fileSelected(call: PluginCall, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            call.resolve(JSObject().put("cancelled", true)); return
        }
        runtime.scope.launch {
            try {
                runtime.download(call.getObject("data")!!.getString("url")!!, uri)
                call.resolve(JSObject().put("cancelled", false))
            } catch (error: Exception) { call.reject(error.message ?: "保存附件失败") }
        }
    }
    private fun dispatch(call: PluginCall) {
        runtime.scope.launch {
            try {
                val data: JSONObject = call.getObject("data") ?: JSObject()
                val result = when (call.getString("action")) {
                    "bootstrap" -> {
                        val stored = runtime.storage()
                        runtime.restoreAudioIntent(stored)
                        JSONObject().put("settings", runtime.settings()).put("storage", stored)
                    }
                    "storage" -> {
                        runtime.putStorage(data.getString("key"), if (data.isNull("value")) null else data.getString("value"))
                        JSONObject()
                    }
                    "preferences" -> { runtime.preferences(data); runtime.settings() }
                    "switchServer" -> { runtime.switchServer(data.getString("server")); runtime.settings() }
                    "connect" -> { runtime.connect(data.optString("origin"), data.getString("token")); JSONObject() }
                    "disconnect" -> { runtime.disconnect(data.optString("origin")); JSONObject() }
                    "send" -> { runtime.send(data.optString("origin"), data.getJSONObject("event")); JSONObject() }
                    "sync" -> { runtime.sync(); JSONObject() }
                    "voice" -> runtime.voiceSnapshot()
                    "prepareVoice", "bluetooth" -> JSONObject()
                    "joinVoice" -> { runtime.joinVoice(data); runtime.voiceSnapshot() }
                    "startCall" -> { runtime.startCall(data); runtime.voiceSnapshot() }
                    "acceptCall" -> { runtime.acceptCall(data); runtime.voiceSnapshot() }
                    "hangup" -> { runtime.hangup(); runtime.voiceSnapshot() }
                    "audio" -> { runtime.audio(data); JSONObject() }
                    "device" -> { runtime.selectDevice(data.getString("id")); runtime.voiceSnapshot() }
                    "ackNotification" -> { runtime.ackNotification(); JSONObject() }
                    "minimize" -> { activity.moveTaskToBack(true); JSONObject() }
                    else -> error("不支持的客户端操作")
                }
                call.resolve(JSObject(result.toString()))
            } catch (error: Exception) {
                call.reject(error.message ?: "客户端操作失败")
            }
        }
    }
}
