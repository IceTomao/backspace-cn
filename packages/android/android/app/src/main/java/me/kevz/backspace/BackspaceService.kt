package me.kevz.backspace

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class BackspaceService : Service() {
    companion object { const val SERVICE_ID = 10 }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).apply {
            createNotificationChannel(NotificationChannel("connection", "后台连接", NotificationManager.IMPORTANCE_LOW))
            createNotificationChannel(NotificationChannel("messages", "聊天消息", NotificationManager.IMPORTANCE_DEFAULT))
            createNotificationChannel(NotificationChannel("calls", "语音来电", NotificationManager.IMPORTANCE_HIGH))
        }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = BackspaceRuntime.get(this)
        when (intent?.action) {
            "hangup" -> runtime.hangup()
            "mute" -> runtime.toggleMuted()
            "offline" -> runtime.setBackground(false)
        }
        val calling = runtime.inCall
        if (!calling && !runtime.background) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "connection")
            .setSmallIcon(R.drawable.ic_notification).setContentTitle("Backspace")
            .setContentText(if (calling) "语音通话中" else "后台在线接收已开启")
            .setContentIntent(open).setOngoing(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        fun action(name: String, title: String, id: Int) {
            notification.addAction(0, title, PendingIntent.getService(this, id,
                Intent(this, BackspaceService::class.java).setAction(name),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        if (calling) {
            action("mute", if (runtime.muted) "取消静音" else "静音", 1)
            action("hangup", "挂断", 2)
        } else action("offline", "关闭后台在线", 3)
        val type = (if (calling) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or
            (if (Build.VERSION.SDK_INT >= 34 && runtime.background) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0)
        ServiceCompat.startForeground(this, SERVICE_ID, notification.build(), type)
        runtime.serviceStarted()
        if (!calling && !runtime.background) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        // Do not resurrect the process, microphone or account after OS termination.
        return START_NOT_STICKY
    }
    override fun onDestroy() {
        super.onDestroy()
        BackspaceRuntime.get(this).serviceDestroyed()
    }
}
