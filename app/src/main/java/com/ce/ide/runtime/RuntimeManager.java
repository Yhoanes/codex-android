package com.ce.ide.runtime;

import android.content.Context;

import com.ce.ide.core.CoreEnvironment;
import com.ce.ide.core.CoreRuntimeState;

import java.io.File;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public final class RuntimeManager {

    public static final String CORE_VERSION = RuntimeConfig.CORE_VERSION;
    private static final String PROCESS_CSRF_TOKEN = generateHexSecret();

    private final Context appContext;
    private final String csrfToken;
    private final RuntimePaths paths;
    private final NetworkMonitorHolder network;
    private final AtomicBoolean envInstallStarted = new AtomicBoolean(false);

    public RuntimeManager(Context context) {
        this.appContext = context.getApplicationContext();
        this.csrfToken = PROCESS_CSRF_TOKEN;
        this.paths = new RuntimePaths(context);
        this.network = new NetworkMonitorHolder(context);
    }

    private static String generateHexSecret() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : raw) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    public Context appContext() {
        return appContext;
    }

    public int getHttpsPort() {
        return RuntimeConfig.httpsPort(appContext);
    }

    public String getCsrfToken() {
        return csrfToken;
    }

    public File getRuntimeDir() {
        return paths.getRuntimeDir();
    }

    public File getWebDir() {
        return paths.getWebDir();
    }

    public File getBinDir() {
        return paths.getBinDir();
    }

    public File getLibDir() {
        return paths.getLibDir();
    }

    public File getNodeLibDir() {
        return paths.getNodeLibDir();
    }

    public File getCertFile() {
        return paths.getCertFile();
    }

    public File getCodexDir() {
        return paths.getCodexDir();
    }

    public File getOcConfigDir() {
        return paths.getOcConfigDir();
    }

    public File getOcDataDir() {
        return paths.getOcDataDir();
    }

    public File getGeminiDir() {
        return paths.getGeminiDir();
    }

    public File getAppDataDir() {
        return paths.getAppDataDir();
    }

    public File getProjectsDir() {
        return paths.getProjectsDir();
    }

    public File getDefaultWorkspaceDir() {
        return paths.getDefaultWorkspaceDir();
    }

    public synchronized void installCore() {
        CoreInstaller.installCore(this);
    }

    public void installEnvInBackground() {
        EnvInstallScheduler.schedule(this, envInstallStarted);
    }

    /** Command to boot the standalone Codex ARM64 Host server. */
    public String[] coreCommand() {
        File core = new File(getBinDir(), RuntimePaths.CORE_NAME);
        if (!core.isFile()) {
            throw new IllegalStateException("Codex host launcher missing: " + core);
        }
        List<String> cmd = new ArrayList<>();
        cmd.add(core.getAbsolutePath());
        cmd.add("--host");
        cmd.add("127.0.0.1");
        cmd.add("--port");
        cmd.add(String.valueOf(getHttpsPort()));
        return cmd.toArray(new String[0]);
    }

    public void applyEnvironment(ProcessBuilder pb) {
        CoreEnvironment.apply(this, pb);
    }

    public void startNetworkMonitor() {
        network.start();
    }

    public synchronized void refreshNetwork() {
        writeNetworkConfig();
        if (CoreRuntimeState.serverUrl != null) {
            android.util.Log.d("RuntimeManager", "network changed; rewrote DNS config (host stays up)");
        } else {
            android.util.Log.d("RuntimeManager", "network changed; DNS config refreshed");
        }
    }

    public synchronized void writeNetworkConfig() {
        NetworkConfigWriter.write(appContext);
    }
}
