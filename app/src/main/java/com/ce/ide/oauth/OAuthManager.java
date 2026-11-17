package com.ce.ide.oauth;

import android.content.Context;
import android.util.Log;

import com.ce.ide.util.CoreUrl;

/**
 * OAuth is delegated to an external browser (Google and OpenAI block embedded WebView login).
 * Thin facade over the URL matcher and Custom Tab / default browser launcher.
 */
public final class OAuthManager {

    private final AuthUrlMatcher matcher = new AuthUrlMatcher();
    private final CustomTabLauncher launcher = new CustomTabLauncher();

    /** True when the URL must leave the WebView and go to the system browser. */
    public boolean isAuthUrl(String url) {
        return matcher.isAuthUrl(url);
    }

    /**
     * Intercepts an auth URL. Returns true if it was handled (opened externally),
     * false if the WebView should load it normally.
     */
    public boolean intercept(Context context, String url) {
        boolean auth = matcher.isAuthUrl(url);
        String safeUrl = CoreUrl.stripUrlSecrets(url);
        Log.i(OAuthConstants.TAG, "intercept isAuthUrl=" + auth + " url=" + safeUrl);
        if (!auth) {
            return false;
        }
        Log.i(OAuthConstants.TAG, "isAuthUrl matched -> external browser: " + safeUrl);
        return launcher.openInBrowser(context, url);
    }

    /** Opens the URL in the system browser (`http`/`https` only). */
    public boolean openInBrowser(Context context, String url) {
        return launcher.openInBrowser(context, url);
    }
}
