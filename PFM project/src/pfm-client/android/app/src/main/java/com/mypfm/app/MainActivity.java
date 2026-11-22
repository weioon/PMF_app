package com.mypfm.app;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.text.TextUtils;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.lang.ref.WeakReference;

public class MainActivity extends BridgeActivity {

    private static WeakReference<MainActivity> sActiveInstance = new WeakReference<>(null);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sActiveInstance = new WeakReference<>(this);
        ensureListenerRebound();
        if (this.bridge != null && this.bridge.getWebView() != null) {
            WebView webView = this.bridge.getWebView();
            webView.clearCache(true);
            WebSettings settings = webView.getSettings();
            if (settings != null) {
                settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
                settings.setDomStorageEnabled(true);
                settings.setDatabaseEnabled(true);
            }
            webView.addJavascriptInterface(new AndroidNotificationBridge(), "AndroidNotificationBridge");
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        sActiveInstance = new WeakReference<>(this);
        ensureListenerRebound();
        PfmNotificationListenerService.scanActiveNotificationsIfConnected();
        flushQueuedNotificationsToWebView();
        if (this.bridge != null && this.bridge.getWebView() != null) {
            final WebView webView = this.bridge.getWebView();
            webView.postDelayed(this::flushQueuedNotificationsToWebView, 450);
            webView.postDelayed(this::flushQueuedNotificationsToWebView, 1400);
        }
    }

    private void ensureListenerRebound() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                NotificationListenerService.requestRebind(
                        new ComponentName(this, PfmNotificationListenerService.class)
                );
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (sActiveInstance.get() == this) {
            sActiveInstance.clear();
        }
    }

    public static void notifyWebViewNewNotification() {
        final MainActivity activity = sActiveInstance.get();
        if (activity != null) {
            activity.runOnUiThread(activity::flushQueuedNotificationsToWebView);
        }
    }

    private void flushQueuedNotificationsToWebView() {
        if (this.bridge != null && this.bridge.getWebView() != null) {
            final WebView webView = this.bridge.getWebView();
            webView.post(() -> webView.evaluateJavascript(
                    "if (window.flushNativeNotifications) { window.flushNativeNotifications(); }",
                    null
            ));
        }
    }

    public class AndroidNotificationBridge {

        @JavascriptInterface
        public boolean isNotificationListenerEnabled() {
            try {
                String pkgName = getPackageName();
                final String flat = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
                if (!TextUtils.isEmpty(flat)) {
                    final String[] names = flat.split(":");
                    for (String name : names) {
                        final ComponentName cn = ComponentName.unflattenFromString(name);
                        if (cn != null && TextUtils.equals(pkgName, cn.getPackageName())) {
                            return true;
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            return false;
        }

        @JavascriptInterface
        public boolean openNotificationListenerSettings() {
            try {
                Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS");
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(fallback);
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }
        }

        @JavascriptInterface
        public String drainPendingNotifications() {
            return PfmNotificationListenerService.drainQueue(getApplicationContext());
        }
    }
}
