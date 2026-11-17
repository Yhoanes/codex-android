package com.ce.ide.ui.webview;

import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebView;

import com.ce.ide.bridge.AndroidBridge;
import com.ce.ide.runtime.RuntimePaths;
import com.ce.ide.theme.ThemeManager;

import java.io.File;

/**
 * Loads the local Codex Host loopback origin (`http://127.0.0.1:<port>/?theme=...`)
 * after provisioning the per-boot HttpOnly SameSite=Strict `ce_auth` cookie so the
 * official OpenAI Codex webview, API calls, and WebSocket (`/ws`) authenticate cleanly.
 */
public final class AppLoader {

    private static final String TAG = "WebViewHost";

    private AppLoader() {
    }

    public static void load(Context context, WebView webView, ThemeManager theme,
                            AndroidBridge bridge) {
        int port = bridge.getEnginePort();
        if (theme != null) {
            theme.applyToWebView(webView);
        }

        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cm.setAcceptThirdPartyCookies(webView, true);
            }
            String hostToken = bridge.getInternalCsrfToken();
            if (hostToken != null && !hostToken.isEmpty()) {
                String cookie = "ce_auth=" + hostToken + "; Path=/; HttpOnly; SameSite=Strict";
                cm.setCookie("http://127.0.0.1:" + port, cookie);
                cm.setCookie("http://localhost:" + port, cookie);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    cm.flush();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "cookie setup warning: " + e.getMessage());
        }

        String resolvedTheme = (theme != null) ? theme.getTheme() : "dark";
        if (!"light".equals(resolvedTheme)) {
            resolvedTheme = "dark";
        }

        LocalAssetServer.setHostThemeHint(resolvedTheme);
        bridge.setCoreOriginActive(true);
        try {
            File defaultWs = new RuntimePaths(context).getDefaultWorkspaceDir();
            if (defaultWs != null && !defaultWs.isDirectory()) {
                defaultWs.mkdirs();
            }
        } catch (Exception e) {
            Log.w(TAG, "default workspace mkdirs warning: " + e.getMessage());
        }
        webView.loadUrl("http://127.0.0.1:" + port + "/?theme=" + resolvedTheme);
    }
}
