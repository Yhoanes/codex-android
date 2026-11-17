package com.ce.ide.runtime;

import android.content.Context;
import android.os.Environment;

import java.io.File;

/** Resolves the app-private runtime/web/user-state directories and asset names for Codex Android. */
public final class RuntimePaths {

    public static final String RUNTIME_ASSET = "runtime";
    public static final String CORE_ARCHIVE_ASSET = "core-archive/codex-core.tar.gz";
    public static final String WEBVIEW_PAK_ASSET = "core-archive/webview-bundle.pak";
    public static final String WEB_ASSET = "web";
    public static final String MANIFEST_ASSET = RUNTIME_ASSET + "/manifest.json";
    public static final String SEED_ASSET = RUNTIME_ASSET + "/seed";
    public static final String RUNTIME_MARKER = ".installed";
    public static final String WEB_MARKER = ".web_installed";

    public static final String BIN_DIR = "runtime/bin";
    public static final String LIB_DIR = "runtime/lib";
    public static final String NODE_LIB_DIR = "runtime/node-lib";
    public static final String CERT_REL = "runtime/certs/ca-certificates.crt";
    public static final String CORE_NAME = "codex-host";

    public static final String CODEX_DIR_REL = ".codex";
    public static final String OC_CONFIG_REL = ".codex";
    public static final String OC_DATA_REL = ".local/share/codex";
    public static final String GEMINI_DIR = ".gemini";
    public static final String CONFIG_PROJECTS = "sessions";

    private final Context appContext;

    public RuntimePaths(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public File getRuntimeDir() {
        return new File(appContext.getFilesDir(), RUNTIME_ASSET);
    }

    public File getWebDir() {
        return new File(appContext.getFilesDir(), WEB_ASSET);
    }

    public File getBinDir() {
        return new File(appContext.getFilesDir(), BIN_DIR);
    }

    public File getLibDir() {
        return new File(appContext.getFilesDir(), LIB_DIR);
    }

    public File getNodeLibDir() {
        return new File(appContext.getFilesDir(), NODE_LIB_DIR);
    }

    public File getCertFile() {
        return new File(appContext.getFilesDir(), CERT_REL);
    }

    public File getCodexDir() {
        return new File(appContext.getFilesDir(), CODEX_DIR_REL);
    }

    public File getOcConfigDir() {
        return getCodexDir();
    }

    public File getOcDataDir() {
        return new File(appContext.getFilesDir(), OC_DATA_REL);
    }

    public File getGeminiDir() {
        return new File(appContext.getFilesDir(), GEMINI_DIR);
    }

    public File getAppDataDir() {
        return getOcDataDir();
    }

    public File getProjectsDir() {
        return new File(getCodexDir(), CONFIG_PROJECTS);
    }

    public File getDefaultWorkspaceDir() {
        try {
            File extDocs = new File(Environment.getExternalStorageDirectory(), "Documents/Codex");
            if ((extDocs.isDirectory() || extDocs.mkdirs()) && extDocs.canWrite()) {
                return extDocs;
            }
        } catch (Throwable ignored) {
        }
        File internalWs = new File(appContext.getFilesDir(), "workspace");
        if (!internalWs.isDirectory()) {
            internalWs.mkdirs();
        }
        return internalWs;
    }
}
