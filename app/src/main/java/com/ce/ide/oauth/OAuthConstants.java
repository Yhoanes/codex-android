package com.ce.ide.oauth;

import com.ce.ide.BuildConfig;

/** OAuth/Custom-Tab constants for Codex Android (no androidx.browser dependency). */
public final class OAuthConstants {

    public static final String TAG = "OAuthManager";

    public static final String CHROME_PACKAGE = "com.android.chrome";

    public static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    public static final String EXTRA_TOOLBAR_COLOR =
            "android.support.customtabs.extra.TOOLBAR_COLOR";
    public static final String EXTRA_APP_ID = "com.android.browser.application_id";
    public static final int TOOLBAR_COLOR_DARK = 0xFF0D0D0D;

    public static final String CALLBACK_SCHEME = BuildConfig.OAUTH_SCHEME;
    public static final String CALLBACK_HOST = "oauth-success";
    public static final String CALLBACK_HOST_COMPAT = "auth-success";

    /** Codex persists OAuth credentials in <filesDir>/.codex/auth.json. */
    public static final String TOKEN_DIR = ".codex";
    public static final String TOKEN_NAME = "auth.json";

    private OAuthConstants() {
    }
}
