package com.mypfm.app;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Native Android NotificationListenerService for MyPFM Auto-Tracking.
 * Captures payment & transfer notifications from Malaysian banks and e-wallets
 * (even when the app is closed in the background) and queues them in SharedPreferences
 * for atomic ingestion by the WebView ledger engine.
 */
public class PfmNotificationListenerService extends NotificationListenerService {

    public static final String PREFS_NAME = "MyPfmNotificationQueue";
    public static final String KEY_QUEUE = "pending_queue";

    private static final Set<String> KNOWN_FINANCIAL_PACKAGES = new HashSet<>(Arrays.asList(
        "my.com.tngdigital.ewallet",
        "com.maybank2u.life",
        "com.cimbmalaysia",
        "my.com.cimb.octo",
        "my.com.gxbank.app",
        "com.shopee.my",
        "com.rytbank.app",
        "my.com.ytl.rytbank",
        "my.com.aeonbank",
        "my.com.boostbank",
        "my.com.myboost",
        "com.pbebank.pbengage",
        "my.com.publicbank.pbengage",
        "my.com.hongleongconnect.mobilebanking",
        "com.rhbgroup.rhbmobilebanking",
        "com.ambank.ambankonline",
        "com.bankislam.bimbmobile",
        "com.asnb.myasnb",
        "com.grabtaxi.passenger",
        "com.bigpayme.bigpay"
    ));

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) return;
        try {
            String packageName = sbn.getPackageName();
            if (packageName == null || "com.mypfm.app".equals(packageName) || "android".equals(packageName) || packageName.startsWith("com.android.")) {
                return;
            }

            Notification notification = sbn.getNotification();
            if (notification == null || notification.extras == null) return;
            if ((notification.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;

            Bundle extras = notification.extras;
            CharSequence titleCs = extras.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence textCs = extras.getCharSequence(Notification.EXTRA_TEXT);
            CharSequence bigTextCs = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);

            String title = titleCs != null ? titleCs.toString().trim() : "";
            String text = bigTextCs != null && bigTextCs.length() > 0
                    ? bigTextCs.toString().trim()
                    : (textCs != null ? textCs.toString().trim() : "");

            if (title.isEmpty() && text.isEmpty()) return;

            String combined = (title + " " + text).toUpperCase();
            boolean isKnownPackage = KNOWN_FINANCIAL_PACKAGES.contains(packageName);
            boolean hasCurrencyMention = combined.contains("RM") || combined.contains("MYR");

            if (!isKnownPackage && !hasCurrencyMention) {
                return;
            }

            long postedAt = sbn.getPostTime() > 0 ? sbn.getPostTime() : System.currentTimeMillis();

            JSONObject item = new JSONObject();
            item.put("packageName", packageName);
            item.put("title", title);
            item.put("text", text);
            item.put("postedAt", postedAt);

            enqueueNotification(getApplicationContext(), item);
            MainActivity.notifyWebViewNewNotification();
        } catch (Exception ignored) {
            // Never crash the notification listener service
        }
    }

    public static synchronized void enqueueNotification(Context context, JSONObject item) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_QUEUE, "[]");
            JSONArray arr;
            try {
                arr = new JSONArray(raw);
            } catch (Exception e) {
                arr = new JSONArray();
            }
            // Keep max 200 recent notifications in offline queue
            if (arr.length() >= 200) {
                JSONArray trimmed = new JSONArray();
                for (int i = arr.length() - 199; i < arr.length(); i++) {
                    trimmed.put(arr.get(i));
                }
                arr = trimmed;
            }
            arr.put(item);
            prefs.edit().putString(KEY_QUEUE, arr.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    public static synchronized String drainQueue(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_QUEUE, "[]");
            if (!"[]".equals(raw)) {
                prefs.edit().putString(KEY_QUEUE, "[]").apply();
            }
            return raw;
        } catch (Exception e) {
            return "[]";
        }
    }
}

