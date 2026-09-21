package me.kevz.backspace;

import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebViewCompat;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(BackspaceNativePlugin.class);
        super.onCreate(state);
        bridge.getWebView().removeJavascriptInterface("androidBridge");
        // Reject legacy WebViews whose bridge cannot restrict calls to a main-frame origin.
        var webViewPackage = WebViewCompat.getCurrentWebViewPackage(this);
        int webViewMajor = 0;
        try { webViewMajor = Integer.parseInt(webViewPackage.versionName.split("\\.")[0]); }
        catch (Exception ignored) {}
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || webViewMajor < 118) {
            new android.app.AlertDialog.Builder(this).setMessage("请更新 Android System WebView 后重新打开 Backspace")
                .setPositiveButton("退出", (dialog, which) -> finish()).setCancelable(false).show();
            return;
        }
        bridge.getWebView().getSettings().setAllowFileAccess(false);
        // The system file picker returns user-selected content:// URIs.
        // Navigation remains local-only in BackspaceNativePlugin.
        bridge.getWebView().getSettings().setAllowContentAccess(true);
        BackspaceRuntime.get(this).setOnTheme(() -> { applyTheme(); return kotlin.Unit.INSTANCE; });
        applyTheme();
        readNotification(getIntent());
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { BackspaceRuntime.get(MainActivity.this).backPressed(); }
        });
    }
    private void applyTheme() {
        boolean dark = BackspaceRuntime.get(this).settings().optBoolean("dark");
        bridge.getWebView().setBackgroundColor(Color.parseColor(dark ? "#0b0b10" : "#ffffff"));
        var controller = WindowCompat.getInsetsController(getWindow(), bridge.getWebView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }
    @Override public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        applyTheme();
        BackspaceRuntime.get(this).preferences(new JSONObject());
    }
    @Override public void onResume() {
        super.onResume();
        BackspaceRuntime.get(this).setForeground(true);
    }
    @Override public void onStop() {
        BackspaceRuntime.get(this).setForeground(false);
        super.onStop();
    }
    @Override public void onDestroy() {
        BackspaceRuntime.get(this).setOnTheme(null);
        super.onDestroy();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        readNotification(intent);
    }
    private void readNotification(Intent intent) {
        String payload = intent.getStringExtra("notification");
        if (payload == null) return;
        try { BackspaceRuntime.get(this).notificationOpened(new JSONObject(payload)); }
        catch (Exception ignored) {}
        intent.removeExtra("notification");
    }
}
