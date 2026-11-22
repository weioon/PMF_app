package com.mypfm.app;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Native Android NotificationListenerService for MyPFM Auto-Tracking.
 * Captures payment & transfer notifications from Malaysian banks and e-wallets
 * (even when the app is closed or phone is asleep) and queues them in SharedPreferences
 * for atomic ingestion by the WebView ledger engine.
 */
public class PfmNotificationListenerService extends NotificationListenerService {

    public static final String PREFS_NAME = "MyPfmNotificationQueue";
    public static final String KEY_QUEUE = "pending_queue";
    public static final String KEY_SEEN = "seen_keys";

    private static WeakReference<PfmNotificationListenerService> sActiveService = new WeakReference<>(null);

    private static final Set<String> KNOWN_FINANCIAL_PACKAGES = new HashSet<>(Arrays.asList(
        "my.com.tngdigital.ewallet",
        "com.maybank2u.life",
        "com.maybank2u.m2umobile",
        "com.cimbmalaysia",
        "my.com.cimb.octo",
        "com.cimb.cimbocto",
        "my.com.gxbank.app",
        "com.gxbank.app",
        "com.shopee.my",
        "com.rytbank.app",
        "my.com.ytl.rytbank",
        "my.com.rytbank",
        "my.com.aeonbank",
        "my.com.aeonbank.app",
        "com.aeonbank.app",
        "my.com.boostbank",
        "my.com.boostbank.app",
        "com.boostbank.app",
        "my.com.myboost",
        "com.pbebank.pbengage",
        "my.com.publicbank.pbengage",
        "com.publicbank.pbengage",
        "my.com.hongleongconnect.mobilebanking",
        "my.com.hongleongconnect.mobileconnect",
        "com.rhbgroup.rhbmobilebanking",
        "com.ambank.ambankonline",
        "my.com.ambank.amonline",
        "com.bankislam.bimbmobile",
        "com.bankislam.go",
        "my.com.bankislam.go",
        "com.bsn.mybsn",
        "my.com.bsn.mybsn",
        "com.asnb.myasnb",
        "com.grabtaxi.passenger",
        "com.bigpayme.bigpay"
    ));

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        sActiveService = new WeakReference<>(this);
        scanCurrentActiveNotifications();
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        if (sActiveService.get() == this) {
            sActiveService.clear();
        }
    }

    public static void scanActiveNotificationsIfConnected() {
        PfmNotificationListenerService svc = sActiveService.get();
        if (svc != null) {
            svc.scanCurrentActiveNotifications();
        }
    }

    private void scanCurrentActiveNotifications() {
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) return;
            for (StatusBarNotification sbn : active) {
                processStatusBarNotification(sbn, false);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        sActiveService = new WeakReference<>(this);
        processStatusBarNotification(sbn, true);
    }

    private void processStatusBarNotification(StatusBarNotification sbn, boolean notifyImmediately) {
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
            CharSequence titleBigCs = extras.getCharSequence(Notification.EXTRA_TITLE_BIG);
            CharSequence textCs = extras.getCharSequence(Notification.EXTRA_TEXT);
            CharSequence bigTextCs = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
            CharSequence subTextCs = extras.getCharSequence(Notification.EXTRA_SUB_TEXT);
            CharSequence summaryCs = extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT);
            CharSequence infoCs = extras.getCharSequence(Notification.EXTRA_INFO_TEXT);
            CharSequence[] textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
            CharSequence tickerCs = notification.tickerText;

            String title = titleBigCs != null && titleBigCs.length() > 0
                    ? titleBigCs.toString().trim()
                    : (titleCs != null ? titleCs.toString().trim() : "");

            StringBuilder bodyBuilder = new StringBuilder();
            if (bigTextCs != null && bigTextCs.length() > 0) {
                bodyBuilder.append(bigTextCs.toString().trim());
            }
            if (textCs != null && textCs.length() > 0) {
                String tStr = textCs.toString().trim();
                if (bodyBuilder.indexOf(tStr) == -1) {
                    if (bodyBuilder.length() > 0) bodyBuilder.append(" ");
                    bodyBuilder.append(tStr);
                }
            }
            if (textLines != null) {
                for (CharSequence line : textLines) {
                    if (line != null && line.length() > 0) {
                        String lStr = line.toString().trim();
                        if (bodyBuilder.indexOf(lStr) == -1) {
                            if (bodyBuilder.length() > 0) bodyBuilder.append(" ");
                            bodyBuilder.append(lStr);
                        }
                    }
                }
            }
            if (subTextCs != null && subTextCs.length() > 0) {
                String sStr = subTextCs.toString().trim();
                if (bodyBuilder.indexOf(sStr) == -1) {
                    if (bodyBuilder.length() > 0) bodyBuilder.append(" ");
                    bodyBuilder.append(sStr);
                }
            }
            if (summaryCs != null && summaryCs.length() > 0) {
                String sumStr = summaryCs.toString().trim();
                if (bodyBuilder.indexOf(sumStr) == -1) {
                    if (bodyBuilder.length() > 0) bodyBuilder.append(" ");
                    bodyBuilder.append(sumStr);
                }
            }
            if (infoCs != null && infoCs.length() > 0) {
                String iStr = infoCs.toString().trim();
                if (bodyBuilder.indexOf(iStr) == -1) {
                    if (bodyBuilder.length() > 0) bodyBuilder.append(" ");
                    bodyBuilder.append(iStr);
                }
            }
            if (tickerCs != null && tickerCs.length() > 0) {
                String tkStr = tickerCs.toString().trim();
                if (bodyBuilder.indexOf(tkStr) == -1) {
                    if (bodyBuilder.length() > 0) bodyBuilder.append(" ");
                    bodyBuilder.append(tkStr);
                }
            }

            String text = bodyBuilder.toString().trim();
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

            boolean added = enqueueNotification(getApplicationContext(), item);
            if (added && notifyImmediately) {
                MainActivity.notifyWebViewNewNotification();
            }
        } catch (Exception ignored) {
            // Never crash the notification listener service
        }
    }

    public static synchronized boolean enqueueNotification(Context context, JSONObject item) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String dedupKey = item.optString("packageName", "") + "|"
                    + item.optLong("postedAt", 0) + "|"
                    + item.optString("title", "") + "|"
                    + item.optString("text", "");

            String seenRaw = prefs.getString(KEY_SEEN, "[]");
            JSONArray seenArr;
            try {
                seenArr = new JSONArray(seenRaw);
            } catch (Exception e) {
                seenArr = new JSONArray();
            }
            for (int i = 0; i < seenArr.length(); i++) {
                if (dedupKey.equals(seenArr.optString(i))) {
                    return false;
                }
            }
            if (seenArr.length() >= 300) {
                JSONArray trimmedSeen = new JSONArray();
                for (int i = seenArr.length() - 299; i < seenArr.length(); i++) {
                    trimmedSeen.put(seenArr.get(i));
                }
                seenArr = trimmedSeen;
            }
            seenArr.put(dedupKey);

            String raw = prefs.getString(KEY_QUEUE, "[]");
            JSONArray arr;
            try {
                arr = new JSONArray(raw);
            } catch (Exception e) {
                arr = new JSONArray();
            }
            if (arr.length() >= 200) {
                JSONArray trimmed = new JSONArray();
                for (int i = arr.length() - 199; i < arr.length(); i++) {
                    trimmed.put(arr.get(i));
                }
                arr = trimmed;
            }
            arr.put(item);
            prefs.edit()
                .putString(KEY_SEEN, seenArr.toString())
                .putString(KEY_QUEUE, arr.toString())
                .apply();
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    public static synchronized String drainQueue(Context context) {
        try {
            scanActiveNotificationsIfConnected();
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

