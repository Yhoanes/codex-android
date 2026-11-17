package com.ce.ide.bridge;

import android.util.Log;

import com.ce.ide.core.CoreRuntimeState;
import com.ce.ide.core.CoreServerService;
import com.ce.ide.runtime.RuntimeManager;
import com.ce.ide.util.AtomicFileWriter;
import com.ce.ide.util.CoreUrl;
import com.ce.ide.util.FileModeUtil;
import com.ce.ide.util.IoUtil;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Exposes Codex server state, restart controls, live core.log reader,
 * and the 1-Tap "Built for Android" MCP Plugin Hub (downloading native ARM64 Rust/Bionic
 * plugins from Yhoanes/antigravity-android-plugins, rewriting sandbox paths to com.ce.ide,
 * running install-plugin.sh, syncing SKILL.md + rules/*.md into ~/.codex/{skills,rules}
 * and ~/.agents/skills, and registering mcp_servers in ~/.codex/config.toml).
 */
public final class EngineBridge {

    private static final String TAG = "EngineBridge";
    private static final String ANDROID_PLUGINS_REPO_BASE =
            "https://raw.githubusercontent.com/Yhoanes/antigravity-android-plugins/main/plugins/";
    private static final long MAX_ZIP_DOWNLOAD_BYTES = 256L * 1024L * 1024L;
    private static final long MAX_EXTRACTED_TOTAL_BYTES = 600L * 1024L * 1024L;
    private static final int MAX_ZIP_ENTRIES = 5000;
    private static final int MAX_HOOK_OUTPUT_BYTES = 32768;

    private final RuntimeManager runtime;

    public EngineBridge(RuntimeManager runtime) {
        this.runtime = runtime;
    }

    public boolean isReady() {
        return CoreRuntimeState.serverUrl != null;
    }

    public int getPort() {
        int live = CoreRuntimeState.httpsPort;
        return live > 0 ? live : runtime.getHttpsPort();
    }

    public String getBaseUrl() {
        return CoreUrl.baseUrl(getPort());
    }

    public String getCsrfToken() {
        String live = CoreRuntimeState.csrfToken;
        return live != null ? live : runtime.getCsrfToken();
    }

    private File getPluginHubDir() {
        File d = new File(runtime.getCodexDir(), "plugins-hub");
        if (!d.isDirectory()) {
            d.mkdirs();
        }
        return d;
    }

    private File getHubStateFile() {
        return new File(runtime.getCodexDir(), "android-plugins.json");
    }

    private File getCodexTomlFile() {
        return new File(runtime.getCodexDir(), "config.toml");
    }

    private static java.util.Set<String> readConfiguredMcpIdsFromToml(File tomlFile) {
        java.util.Set<String> ids = new java.util.HashSet<>();
        if (tomlFile == null || !tomlFile.isFile()) return ids;
        try (FileInputStream fis = new FileInputStream(tomlFile)) {
            String txt = IoUtil.readAll(fis, "UTF-8");
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("^\\s*\\[mcp_servers\\.([A-Za-z0-9_-]+)\\]", java.util.regex.Pattern.MULTILINE)
                    .matcher(txt);
            while (m.find()) {
                ids.add(m.group(1));
            }
        } catch (Exception ignored) {
        }
        return ids;
    }

    private static String tomlQuote(String s) {
        if (s == null) return "\"\"";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    private static void upsertOrRemoveCodexTomlMcp(File tomlFile, String serverName, JSONObject entry) {
        if (tomlFile == null || serverName == null) return;
        String safeId = serverName.replaceAll("[^A-Za-z0-9_-]", "");
        if (safeId.isEmpty()) return;
        try {
            File parent = tomlFile.getParentFile();
            if (parent != null && !parent.isDirectory()) parent.mkdirs();
            String txt = "";
            if (tomlFile.isFile()) {
                try (FileInputStream fis = new FileInputStream(tomlFile)) {
                    txt = IoUtil.readAll(fis, "UTF-8");
                }
            }
            String blockPattern = "\\n?\\[mcp_servers\\." + java.util.regex.Pattern.quote(safeId)
                    + "(?:\\.(?:env|http_headers))?\\][\\s\\S]*?(?=\\n\\[|$)";
            txt = txt.replaceAll(blockPattern, "").replaceAll("\\s+$", "");

            if (entry != null) {
                StringBuilder sb = new StringBuilder();
                sb.append("\n\n[mcp_servers.").append(safeId).append("]\n");
                String url = entry.optString("url", "");
                if (!url.isEmpty()) {
                    sb.append("url = ").append(tomlQuote(url)).append("\n");
                    JSONObject hdrs = entry.optJSONObject("headers");
                    if (hdrs != null && hdrs.length() > 0) {
                        sb.append("[mcp_servers.").append(safeId).append(".http_headers]\n");
                        Iterator<String> hKeys = hdrs.keys();
                        while (hKeys.hasNext()) {
                            String hk = hKeys.next();
                            if (hk != null && !hk.trim().isEmpty()) {
                                sb.append(tomlQuote(hk.trim())).append(" = ")
                                        .append(tomlQuote(hdrs.optString(hk, ""))).append("\n");
                            }
                        }
                    }
                } else {
                    sb.append("command = ").append(tomlQuote(entry.optString("command", ""))).append("\n");
                    JSONArray args = entry.optJSONArray("args");
                    sb.append("args = [");
                    if (args != null) {
                        for (int i = 0; i < args.length(); i++) {
                            if (i > 0) sb.append(", ");
                            sb.append(tomlQuote(args.optString(i, "")));
                        }
                    }
                    sb.append("]\n");
                }
                JSONObject env = entry.optJSONObject("env");
                if (env != null && env.length() > 0) {
                    sb.append("[mcp_servers.").append(safeId).append(".env]\n");
                    Iterator<String> keys = env.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        if (k != null && k.matches("^[A-Za-z_][A-Za-z0-9_]*$")) {
                            sb.append(k).append(" = ").append(tomlQuote(env.optString(k, ""))).append("\n");
                        }
                    }
                }
                txt = txt + sb.toString();
            } else if (!txt.isEmpty()) {
                txt = txt + "\n";
            }
            AtomicFileWriter.writeText(tomlFile, txt);
        } catch (Exception e) {
            Log.w(TAG, "upsertOrRemoveCodexTomlMcp warning: " + e.getMessage());
        }
    }

    private static String resolvePluginArchiveUrl(String safeName, String archiveUrl) {
        if (archiveUrl != null && !archiveUrl.trim().isEmpty()) {
            String trimmed = archiveUrl.trim();
            try {
                URL candidate = new URL(trimmed);
                if (!isAllowedPluginArchiveUrl(candidate, false)) {
                    throw new SecurityException("Untrusted plugin archive URL: " + trimmed);
                }
                return trimmed;
            } catch (SecurityException se) {
                throw se;
            } catch (Exception e) {
                throw new SecurityException("Invalid plugin archive URL: " + trimmed);
            }
        }
        return ANDROID_PLUGINS_REPO_BASE + safeName + "/" + safeName + ".zip";
    }

    private static boolean isAllowedPluginArchiveUrl(URL url, boolean isRedirectHop) {
        if (url == null || !"https".equalsIgnoreCase(url.getProtocol())) {
            return false;
        }
        String host = url.getHost();
        if (host == null) {
            return false;
        }
        String lowerHost = host.trim().toLowerCase(java.util.Locale.ROOT);
        String path = url.getPath() != null ? url.getPath() : "";
        if ("raw.githubusercontent.com".equals(lowerHost)
                || "github.com".equals(lowerHost)
                || "codeload.githubusercontent.com".equals(lowerHost)) {
            return path.startsWith("/Yhoanes/");
        }
        if (isRedirectHop) {
            return "objects.githubusercontent.com".equals(lowerHost)
                    || "release-assets.githubusercontent.com".equals(lowerHost);
        }
        return false;
    }

    private static void downloadPluginZipVerified(String initialUrl, File destZip, String expectedSha256) throws Exception {
        String current = initialUrl;
        for (int hop = 0; hop < 6; hop++) {
            URL u = new URL(current);
            if (!isAllowedPluginArchiveUrl(u, hop > 0)) {
                throw new SecurityException("Blocked redirect or untrusted host: " + current);
            }
            HttpURLConnection conn = (HttpURLConnection) u.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("User-Agent", "Codex-Android/" + RuntimeManager.CORE_VERSION);
            try {
                int code = conn.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String loc = conn.getHeaderField("Location");
                    if (loc == null || loc.isEmpty()) {
                        throw new IllegalStateException("Redirect missing Location header");
                    }
                    URL nextUrl = new URL(u, loc);
                    if (!isAllowedPluginArchiveUrl(nextUrl, true)) {
                        throw new SecurityException("Blocked redirect to untrusted host: " + nextUrl.getHost());
                    }
                    current = nextUrl.toString();
                    continue;
                }
                if (code < 200 || code >= 300) {
                    throw new IllegalStateException("HTTP " + code + " downloading plugin archive");
                }
                long declaredLen = conn.getContentLengthLong();
                if (declaredLen > MAX_ZIP_DOWNLOAD_BYTES) {
                    throw new IllegalStateException("Plugin archive exceeds 256 MiB safety limit");
                }
                java.security.MessageDigest sha = java.security.MessageDigest.getInstance("SHA-256");
                long total = 0L;
                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(destZip)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > MAX_ZIP_DOWNLOAD_BYTES) {
                            throw new IllegalStateException("Plugin archive exceeded 256 MiB limit during download");
                        }
                        sha.update(buf, 0, n);
                        out.write(buf, 0, n);
                    }
                }
                if (expectedSha256 != null && !expectedSha256.trim().isEmpty()) {
                    byte[] dig = sha.digest();
                    StringBuilder hex = new StringBuilder(64);
                    for (byte b : dig) {
                        hex.append(String.format("%02x", b & 0xff));
                    }
                    if (!hex.toString().equalsIgnoreCase(expectedSha256.trim())) {
                        destZip.delete();
                        throw new SecurityException("Plugin archive SHA-256 integrity check failed");
                    }
                }
                return;
            } finally {
                conn.disconnect();
            }
        }
        throw new IllegalStateException("Too many redirects downloading plugin archive");
    }

    /** Returns bundled __ce_plugins_catalog.json directly from filesDir/web for 0-ms UI rendering. */
    public String getPluginsCatalogJson() {
        File catFile = new File(runtime.getWebDir(), "__ce_plugins_catalog.json");
        if (catFile.isFile()) {
            try (FileInputStream fis = new FileInputStream(catFile)) {
                return IoUtil.readAll(fis, "UTF-8");
            } catch (Exception ignored) {
            }
        }
        return "{\"plugins\":[]}";
    }

    /** Returns JSON map of installed Android MCP plugins and their enabled/MCP state. */
    public String listAndroidPlugins() {
        try {
            JSONObject state = readJsonObject(getHubStateFile());
            JSONObject installed = state.optJSONObject("plugins");
            if (installed == null) {
                installed = new JSONObject();
            }
            java.util.Set<String> enabledMcp = readConfiguredMcpIdsFromToml(getCodexTomlFile());

            JSONObject result = new JSONObject();
            File[] dirs = getPluginHubDir().listFiles();
            if (dirs != null) {
                for (File d : dirs) {
                    if (!d.isDirectory() || d.getName().startsWith(".")) continue;
                    String name = d.getName();
                    JSONObject meta = installed.optJSONObject(name);
                    JSONObject item = new JSONObject();
                    boolean enabled = meta == null || meta.optBoolean("enabled", true);
                    JSONArray serverNames = meta != null ? meta.optJSONArray("servers") : null;
                    if (serverNames != null && serverNames.length() > 0) {
                        String firstSrv = serverNames.optString(0, "").replaceAll("[^A-Za-z0-9_-]", "");
                        if (!firstSrv.isEmpty()) {
                            enabled = enabledMcp.contains(firstSrv);
                        }
                    }
                    item.put("installed", true);
                    item.put("enabled", enabled);
                    item.put("version", meta != null ? meta.optString("version", "1.0.0") : "1.0.0");
                    result.put(name, item);
                }
            }
            return result.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    public String installMarketplacePlugin(String pluginName, String archiveUrl,
                                           String expectedSha256, String marketplace, String version) {
        JSONObject res = new JSONObject();
        File hubDir = getPluginHubDir();
        String safeName = sanitizeName(pluginName);
        if (safeName.isEmpty() || ".".equals(safeName) || "..".equals(safeName)) {
            try {
                res.put("ok", false);
                res.put("error", "Invalid plugin name");
            } catch (Exception ignored) {
            }
            return res.toString();
        }
        File targetDir = new File(hubDir, safeName);
        File stagingDir = new File(hubDir, ".staging-" + safeName + "-" + System.currentTimeMillis());
        File backupDir = new File(hubDir, ".backup-" + safeName);
        File tmpZip = new File(runtime.appContext().getCacheDir(),
                safeName + "-" + System.currentTimeMillis() + ".ccplugin.zip");
        boolean swappedTarget = false;
        boolean hadPreviousInstall = targetDir.exists();

        try {
            String url = resolvePluginArchiveUrl(safeName, archiveUrl);
            downloadPluginZipVerified(url, tmpZip, expectedSha256);

            deleteRecursive(stagingDir);
            if (!stagingDir.mkdirs() && !stagingDir.isDirectory()) {
                throw new IllegalStateException("Cannot create staging directory");
            }

            String canonicalStaging = stagingDir.getCanonicalPath();
            int entryCount = 0;
            long totalExtracted = 0L;
            try (ZipInputStream zis = new ZipInputStream(new FileInputStream(tmpZip))) {
                ZipEntry entry;
                byte[] buf = new byte[16384];
                while ((entry = zis.getNextEntry()) != null) {
                    entryCount++;
                    if (entryCount > MAX_ZIP_ENTRIES) {
                        throw new IllegalStateException("Plugin archive exceeds maximum entry limit (" + MAX_ZIP_ENTRIES + ")");
                    }
                    String entryName = entry.getName().replace('\\', '/');
                    while (entryName.startsWith("/")) {
                        entryName = entryName.substring(1);
                    }
                    if (entryName.startsWith(safeName + "/")) {
                        entryName = entryName.substring(safeName.length() + 1);
                    }
                    if (entryName.isEmpty() || entryName.contains("..")) {
                        zis.closeEntry();
                        continue;
                    }
                    File outFile = new File(stagingDir, entryName);
                    if (!outFile.getCanonicalPath().startsWith(canonicalStaging + File.separator)) {
                        throw new SecurityException("Blocked Zip-Slip entry: " + entry.getName());
                    }
                    if (outFile.exists() && isSymlink(outFile)) {
                        throw new SecurityException("Blocked symlink in staging extraction: " + entry.getName());
                    }
                    if (entry.isDirectory()) {
                        outFile.mkdirs();
                    } else {
                        File parent = outFile.getParentFile();
                        if (parent != null && !parent.isDirectory()) {
                            parent.mkdirs();
                        }
                        try (FileOutputStream fos = new FileOutputStream(outFile)) {
                            int n;
                            while ((n = zis.read(buf)) > 0) {
                                totalExtracted += n;
                                if (totalExtracted > MAX_EXTRACTED_TOTAL_BYTES) {
                                    throw new IllegalStateException("Extracted plugin exceeds 600 MiB quota");
                                }
                                fos.write(buf, 0, n);
                            }
                        }
                    }
                    zis.closeEntry();
                }
            } finally {
                tmpZip.delete();
            }

            deleteRecursive(backupDir);
            if (hadPreviousInstall) {
                if (!targetDir.renameTo(backupDir)) {
                    copyRecursive(targetDir, backupDir);
                    deleteRecursive(targetDir);
                }
            }
            if (!stagingDir.renameTo(targetDir)) {
                copyRecursive(stagingDir, targetDir);
                deleteRecursive(stagingDir);
            }
            swappedTarget = true;

            // Mirror/symlink under ~/.gemini/config/plugins/<safeName> for script compatibility
            mirrorCompatPluginPath(safeName, targetDir);

            JSONObject hookRes = runPostInstallAndWireCodex(
                    safeName, targetDir, version != null && !version.isEmpty() ? version : "1.0.0");

            deleteRecursive(backupDir);

            res.put("ok", true);
            res.put("path", targetDir.getAbsolutePath());
            res.put("hookExit", hookRes.optInt("hookExit", 0));
            res.put("servers", hookRes.optJSONArray("servers"));
            res.put("skills", hookRes.optJSONArray("skills"));
            res.put("reloaded", reloadEngineConfigBool());
            return res.toString();
        } catch (Exception e) {
            tmpZip.delete();
            deleteRecursive(stagingDir);
            if (swappedTarget) {
                deleteRecursive(targetDir);
                if (hadPreviousInstall && backupDir.exists()) {
                    if (!backupDir.renameTo(targetDir)) {
                        try {
                            copyRecursive(backupDir, targetDir);
                        } catch (Exception ignored) {
                        }
                        deleteRecursive(backupDir);
                    }
                    mirrorCompatPluginPath(safeName, targetDir);
                } else {
                    deleteRecursive(new File(new File(runtime.getGeminiDir(), "config/plugins"), safeName));
                }
            }
            try {
                res.put("ok", false);
                res.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
            return res.toString();
        }
    }

    public String toggleAndroidPlugin(String pluginName, boolean enabled) {
        JSONObject res = new JSONObject();
        try {
            String safeName = sanitizeName(pluginName);
            File stateFile = getHubStateFile();
            JSONObject state = readJsonObject(stateFile);
            JSONObject plugins = state.optJSONObject("plugins");
            if (plugins == null || !plugins.has(safeName)) {
                res.put("ok", false);
                res.put("error", "Plugin not installed");
                return res.toString();
            }
            JSONObject pMeta = plugins.getJSONObject(safeName);
            pMeta.put("enabled", enabled);

            File targetDir = new File(getPluginHubDir(), safeName);
            File tomlFile = getCodexTomlFile();

            if (enabled) {
                JSONObject savedConfigs = pMeta.optJSONObject("serverConfigs");
                if (savedConfigs != null && savedConfigs.length() > 0) {
                    Iterator<String> keys = savedConfigs.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        JSONObject cfg = savedConfigs.optJSONObject(k);
                        if (cfg != null) {
                            upsertOrRemoveCodexTomlMcp(tomlFile, k, cfg);
                        }
                    }
                } else if (targetDir.isDirectory()) {
                    JSONObject wired = wireMcpConfigIntoCodex(
                            safeName, targetDir, runtime.appContext().getFilesDir().getAbsolutePath());
                    pMeta.put("servers", wired.optJSONArray("names"));
                    pMeta.put("serverConfigs", wired.optJSONObject("configs"));
                }
                syncSkillsAndRules(safeName, targetDir);
            } else {
                JSONArray srvNames = pMeta.optJSONArray("servers");
                if (srvNames != null) {
                    for (int i = 0; i < srvNames.length(); i++) {
                        String sName = srvNames.optString(i, "");
                        if (!sName.isEmpty()) {
                            upsertOrRemoveCodexTomlMcp(tomlFile, sName, null);
                        }
                    }
                } else {
                    upsertOrRemoveCodexTomlMcp(tomlFile, safeName, null);
                }
                removeSkillsAndRules(safeName, pMeta);
            }

            AtomicFileWriter.writeText(stateFile, state.toString(2) + "\n");

            res.put("ok", true);
            res.put("enabled", enabled);
            res.put("reloaded", reloadEngineConfigBool());
            return res.toString();
        } catch (Exception e) {
            try {
                res.put("ok", false);
                res.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
            return res.toString();
        }
    }

    public boolean uninstallMarketplacePlugin(String pluginName) {
        try {
            String safeName = sanitizeName(pluginName);
            if (safeName.isEmpty()) return false;

            File stateFile = getHubStateFile();
            JSONObject state = readJsonObject(stateFile);
            JSONObject plugins = state.optJSONObject("plugins");
            JSONObject pMeta = plugins != null ? plugins.optJSONObject(safeName) : null;

            // Remove MCP servers from ~/.codex/config.toml
            File tomlFile = getCodexTomlFile();
            if (pMeta != null && pMeta.optJSONArray("servers") != null) {
                JSONArray arr = pMeta.optJSONArray("servers");
                for (int i = 0; i < arr.length(); i++) {
                    upsertOrRemoveCodexTomlMcp(tomlFile, arr.optString(i, ""), null);
                }
            } else {
                upsertOrRemoveCodexTomlMcp(tomlFile, safeName, null);
            }

            removeSkillsAndRules(safeName, pMeta);
            deleteRecursive(new File(getPluginHubDir(), safeName));
            deleteRecursive(new File(new File(runtime.getGeminiDir(), "config/plugins"), safeName));

            if (plugins != null && plugins.has(safeName)) {
                plugins.remove(safeName);
                AtomicFileWriter.writeText(stateFile, state.toString(2) + "\n");
            }

            reloadEngineConfigBool();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean reloadEngineConfigBool() {
        int port = getPort();
        if (port <= 0) return false;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/plugins/reload").openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(1500);
            conn.setReadTimeout(3000);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            String tok = getCsrfToken();
            if (tok != null && !tok.isEmpty()) {
                conn.setRequestProperty("X-CE-Token", tok);
            }
            byte[] payload = "{}".getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (java.io.OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }
            int status = conn.getResponseCode();
            return status >= 200 && status < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private JSONObject runPostInstallAndWireCodex(String safeName, File targetDir, String version)
            throws Exception {
        File filesDir = runtime.appContext().getFilesDir();
        String homePath = filesDir.getAbsolutePath();
        normalizeExtractedTree(targetDir, false, homePath);

        int hookExit = 0;
        File installHook = new File(new File(targetDir, "scripts"), "install-plugin.sh");
        if (!installHook.isFile()) {
            installHook = new File(targetDir, "install-plugin.sh");
        }
        if (installHook.isFile()) {
            File prefixDir = new File(filesDir, "usr");
            File prefixBin = new File(prefixDir, "bin");
            File runtimeBin = runtime.getBinDir();
            File bashBin = new File(prefixBin, "bash");
            String shell = bashBin.isFile() ? bashBin.getAbsolutePath() : "/system/bin/sh";

            ProcessBuilder pb = new ProcessBuilder(shell, installHook.getAbsolutePath());
            pb.directory(targetDir);
            pb.redirectErrorStream(true);
            Map<String, String> env = pb.environment();
            env.put("HOME", homePath);
            env.put("PREFIX", prefixDir.getAbsolutePath());
            env.put("TMPDIR", new File(prefixDir, "tmp").getAbsolutePath());
            env.put("CODEX_HOME", runtime.getCodexDir().getAbsolutePath());
            env.put("PLUGIN_ROOT", targetDir.getAbsolutePath());
            env.put("CODEX_PLUGIN_ROOT", targetDir.getAbsolutePath());
            env.put("PATH", prefixBin.getAbsolutePath() + ":" + runtimeBin.getAbsolutePath()
                    + ":" + homePath + "/.local/bin:/system/bin");
            env.put("LD_LIBRARY_PATH", new File(prefixDir, "lib").getAbsolutePath());
            File certFile = new File(prefixDir, "etc/tls/cert.pem");
            if (!certFile.isFile()) {
                certFile = runtime.getCertFile();
            }
            if (certFile.isFile()) {
                env.put("SSL_CERT_FILE", certFile.getAbsolutePath());
                env.put("CURL_CA_BUNDLE", certFile.getAbsolutePath());
            }
            Process p = pb.start();
            try {
                p.getOutputStream().close();
            } catch (Exception ignored) {
            }
            final InputStream pis = p.getInputStream();
            final java.io.ByteArrayOutputStream tailBuf = new java.io.ByteArrayOutputStream(4096);
            Thread drainer = new Thread(() -> {
                byte[] chunk = new byte[4096];
                try {
                    int n;
                    while ((n = pis.read(chunk)) != -1) {
                        synchronized (tailBuf) {
                            tailBuf.write(chunk, 0, n);
                            if (tailBuf.size() > MAX_HOOK_OUTPUT_BYTES * 2) {
                                byte[] cur = tailBuf.toByteArray();
                                tailBuf.reset();
                                tailBuf.write(cur, cur.length - MAX_HOOK_OUTPUT_BYTES, MAX_HOOK_OUTPUT_BYTES);
                            }
                        }
                    }
                } catch (Exception ignored) {
                } finally {
                    try {
                        pis.close();
                    } catch (Exception ignored) {
                    }
                }
            }, "CcPluginHookDrain");
            drainer.setDaemon(true);
            drainer.start();

            boolean finished = p.waitFor(20, TimeUnit.SECONDS);
            if (finished) {
                hookExit = p.exitValue();
                drainer.join(2000);
            } else {
                p.destroyForcibly();
                try {
                    pis.close();
                } catch (Exception ignored) {
                }
                drainer.join(1500);
                throw new IllegalStateException("Plugin post-install timed out after 20s");
            }
            if (hookExit != 0) {
                String tail;
                synchronized (tailBuf) {
                    byte[] rawTail = tailBuf.toByteArray();
                    int start = Math.max(0, rawTail.length - 512);
                    tail = new String(rawTail, start, rawTail.length - start, StandardCharsets.UTF_8).trim();
                }
                throw new IllegalStateException("Plugin post-install failed (exit " + hookExit + ")"
                        + (tail.isEmpty() ? "" : ": " + tail));
            }
            normalizeExtractedTree(targetDir, false, homePath);
        }

        // Sync skills + rules into ~/.codex/{skills,rules} and ~/.agents/skills
        JSONArray syncedSkills = syncSkillsAndRules(safeName, targetDir);

        // Convert mcp_config.json / .mcp.json -> ~/.codex/config.toml ([mcp_servers.<id>])
        JSONObject wired = wireMcpConfigIntoCodex(safeName, targetDir, homePath);
        JSONArray registeredServers = wired.optJSONArray("names");
        if (registeredServers == null) registeredServers = new JSONArray();
        JSONObject serverConfigs = wired.optJSONObject("configs");
        if (serverConfigs == null) serverConfigs = new JSONObject();

        // Persist plugin metadata in ~/.codex/android-plugins.json
        File stateFile = getHubStateFile();
        JSONObject state = readJsonObject(stateFile);
        JSONObject plugins = state.optJSONObject("plugins");
        if (plugins == null) {
            plugins = new JSONObject();
            state.put("plugins", plugins);
        }
        JSONObject pMeta = new JSONObject();
        pMeta.put("enabled", true);
        pMeta.put("version", version);
        pMeta.put("servers", registeredServers);
        pMeta.put("serverConfigs", serverConfigs);
        pMeta.put("skills", syncedSkills);
        plugins.put(safeName, pMeta);
        AtomicFileWriter.writeText(stateFile, state.toString(2) + "\n");

        JSONObject out = new JSONObject();
        out.put("hookExit", hookExit);
        out.put("servers", registeredServers);
        out.put("skills", syncedSkills);
        return out;
    }

    private JSONArray syncSkillsAndRules(String safeName, File targetDir) {
        JSONArray syncedSkills = new JSONArray();
        try {
            File skillsRoot = new File(runtime.getCodexDir(), "skills");
            skillsRoot.mkdirs();
            File agentsSkillsRoot = new File(runtime.appContext().getFilesDir(), ".agents/skills");
            agentsSkillsRoot.mkdirs();
            File pluginSkills = new File(targetDir, "skills");
            if (pluginSkills.isDirectory()) {
                if (new File(pluginSkills, "SKILL.md").isFile()) {
                    File dstRoot = new File(skillsRoot, safeName);
                    deleteRecursive(dstRoot);
                    copyRecursive(pluginSkills, dstRoot);
                    File dstAgentsRoot = new File(agentsSkillsRoot, safeName);
                    deleteRecursive(dstAgentsRoot);
                    copyRecursive(pluginSkills, dstAgentsRoot);
                    syncedSkills.put(safeName);
                }
                File[] children = pluginSkills.listFiles();
                if (children != null) {
                    for (File skillDir : children) {
                        if (skillDir.isDirectory() && new File(skillDir, "SKILL.md").isFile()) {
                            File dst = new File(skillsRoot, skillDir.getName());
                            deleteRecursive(dst);
                            copyRecursive(skillDir, dst);
                            File dstAgents = new File(agentsSkillsRoot, skillDir.getName());
                            deleteRecursive(dstAgents);
                            copyRecursive(skillDir, dstAgents);
                            syncedSkills.put(skillDir.getName());
                        }
                    }
                }
            }
            File rulesRoot = new File(runtime.getCodexDir(), "rules");
            rulesRoot.mkdirs();
            File pluginRules = new File(targetDir, "rules");
            if (pluginRules.isDirectory()) {
                File[] ruleFiles = pluginRules.listFiles();
                if (ruleFiles != null) {
                    for (File rf : ruleFiles) {
                        if (rf.isFile() && rf.getName().endsWith(".md")) {
                            File dst = new File(rulesRoot, safeName + "-" + rf.getName());
                            copyFile(rf, dst);
                        }
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "syncSkillsAndRules warning: " + e.getMessage());
        }
        return syncedSkills;
    }

    private void removeSkillsAndRules(String safeName, JSONObject pMeta) {
        try {
            File skillsRoot = new File(runtime.getCodexDir(), "skills");
            File agentsSkillsRoot = new File(runtime.appContext().getFilesDir(), ".agents/skills");
            if (pMeta != null && pMeta.optJSONArray("skills") != null) {
                JSONArray skills = pMeta.optJSONArray("skills");
                for (int i = 0; i < skills.length(); i++) {
                    String sk = skills.optString(i, "");
                    if (!sk.isEmpty()) {
                        deleteRecursive(new File(skillsRoot, sk));
                        deleteRecursive(new File(agentsSkillsRoot, sk));
                    }
                }
            }
            File rulesRoot = new File(runtime.getCodexDir(), "rules");
            File[] rfs = rulesRoot.listFiles();
            if (rfs != null) {
                for (File rf : rfs) {
                    if (rf.getName().startsWith(safeName + "-")) {
                        rf.delete();
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }

    private JSONObject wireMcpConfigIntoCodex(String safeName, File targetDir, String homePath) {
        JSONObject result = new JSONObject();
        JSONArray names = new JSONArray();
        JSONObject configs = new JSONObject();
        try {
            result.put("names", names);
            result.put("configs", configs);

            File tomlFile = getCodexTomlFile();

            File mcpFile = new File(targetDir, "mcp_config.json");
            if (!mcpFile.isFile()) {
                mcpFile = new File(targetDir, ".mcp.json");
            }
            if (!mcpFile.isFile()) {
                mcpFile = new File(targetDir, "mcp.json");
            }
            if (!mcpFile.isFile()) {
                return result;
            }
            JSONObject src = readJsonObject(mcpFile);
            JSONObject srcServers = src.optJSONObject("mcpServers");
            if (srcServers == null) {
                srcServers = src.optJSONObject("servers");
            }
            if (srcServers == null) {
                return result;
            }

            String pluginRoot = targetDir.getAbsolutePath();
            String prefixPath = new File(homePath, "usr").getAbsolutePath();
            Iterator<String> keys = srcServers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                JSONObject entry = srcServers.optJSONObject(key);
                if (entry == null) continue;

                String serverName = key.equals(safeName) ? safeName : key;
                JSONObject ccEntry = new JSONObject();

                String remoteUrl = entry.optString("url", entry.optString("serverUrl", ""));
                if (!remoteUrl.isEmpty()) {
                    String explicitType = entry.optString("type", "");
                    ccEntry.put("type", "sse".equalsIgnoreCase(explicitType) ? "sse" : "http");
                    ccEntry.put("url", expandVars(remoteUrl, pluginRoot, homePath, prefixPath));
                    JSONObject hdrs = entry.optJSONObject("headers");
                    if (hdrs != null) {
                        ccEntry.put("headers", hdrs);
                    }
                } else {
                    ccEntry.put("type", "stdio");
                    File directStartMcp = new File(targetDir, "mcp/bin/start-mcp.sh");
                    if (directStartMcp.isFile()) {
                        FileModeUtil.setExec(directStartMcp);
                        ccEntry.put("command", "/system/bin/sh");
                        JSONArray directArgs = new JSONArray();
                        directArgs.put(directStartMcp.getAbsolutePath());
                        ccEntry.put("args", directArgs);
                    } else {
                        String cmd = entry.optString("command", "");
                        JSONArray argsOut = new JSONArray();
                        if (cmd.isEmpty()) {
                            JSONArray cmdArr = entry.optJSONArray("command");
                            if (cmdArr != null && cmdArr.length() > 0) {
                                cmd = cmdArr.optString(0, "");
                                for (int i = 1; i < cmdArr.length(); i++) {
                                    argsOut.put(expandVars(cmdArr.optString(i, ""), pluginRoot, homePath, prefixPath));
                                }
                            }
                        }
                        if (cmd.isEmpty()) continue;
                        ccEntry.put("command", expandVars(cmd, pluginRoot, homePath, prefixPath));

                        JSONArray argsIn = entry.optJSONArray("args");
                        if (argsIn != null) {
                            for (int i = 0; i < argsIn.length(); i++) {
                                argsOut.put(expandVars(argsIn.optString(i, ""), pluginRoot, homePath, prefixPath));
                            }
                        }
                        ccEntry.put("args", argsOut);
                    }

                    JSONObject envIn = entry.optJSONObject("env");
                    if (envIn == null) {
                        envIn = entry.optJSONObject("environment");
                    }
                    JSONObject envOut = new JSONObject();
                    envOut.put("HOME", homePath);
                    envOut.put("PREFIX", prefixPath);
                    envOut.put("TMPDIR", prefixPath + "/tmp");
                    envOut.put("CODEX_HOME", runtime.getCodexDir().getAbsolutePath());
                    envOut.put("LD_LIBRARY_PATH", prefixPath + "/lib");
                    envOut.put("PATH", prefixPath + "/bin:" + homePath + "/runtime/bin:" + homePath + "/.local/bin:/system/bin");
                    if (envIn != null) {
                        Iterator<String> ek = envIn.keys();
                        while (ek.hasNext()) {
                            String k = ek.next();
                            envOut.put(k, expandVars(envIn.optString(k, ""), pluginRoot, homePath, prefixPath));
                        }
                    }
                    ccEntry.put("env", envOut);
                }

                upsertOrRemoveCodexTomlMcp(tomlFile, serverName, ccEntry);
                configs.put(serverName, new JSONObject(ccEntry.toString()));
                names.put(serverName);
            }
        } catch (Exception e) {
            Log.w(TAG, "wireMcpConfigIntoCodex warning: " + e.getMessage());
        }
        return result;
    }

    private static String expandVars(String val, String pluginRoot, String homePath, String prefixPath) {
        String pKey1 = "${" + "CLAUDE" + "_PLUGIN_ROOT}";
        String pKey2 = "$" + "CLAUDE" + "_PLUGIN_ROOT";
        if (val == null) return "";
        return val.replace("${CODEX_PLUGIN_ROOT}", pluginRoot)
                .replace("$CODEX_PLUGIN_ROOT", pluginRoot)
                .replace(pKey1, pluginRoot)
                .replace(pKey2, pluginRoot)
                .replace("${PLUGIN_ROOT}", pluginRoot)
                .replace("$PLUGIN_ROOT", pluginRoot)
                .replace("$H/.gemini/config/plugins/", "$H/.codex/plugins-hub/")
                .replace("/data/user/0/com.agy/files/.gemini/config/plugins/", homePath + "/.codex/plugins-hub/")
                .replace("/data/user/0/com.agy/files", homePath)
                .replace("/data/data/com.agy/files", homePath)
                .replace("/data/user/0/com.oc.ide/files", homePath)
                .replace("/data/data/com.oc.ide/files", homePath)
                .replace("${PREFIX}", prefixPath)
                .replace("${HOME}", homePath);
    }

    private void mirrorCompatPluginPath(String safeName, File targetDir) {
        try {
            File compatParent = new File(runtime.getGeminiDir(), "config/plugins");
            compatParent.mkdirs();
            File compatLink = new File(compatParent, safeName);
            deleteRecursive(compatLink);
            try {
                android.system.Os.symlink(targetDir.getAbsolutePath(), compatLink.getAbsolutePath());
            } catch (Throwable t) {
                copyRecursive(targetDir, compatLink);
            }
        } catch (Exception ignored) {
        }
    }

    private static boolean isTextExtension(String lowerName) {
        return lowerName.endsWith(".sh")
                || lowerName.endsWith(".json")
                || lowerName.endsWith(".md")
                || lowerName.endsWith(".toml")
                || lowerName.endsWith(".js")
                || lowerName.endsWith(".cjs")
                || lowerName.endsWith(".mjs")
                || lowerName.endsWith(".py")
                || lowerName.endsWith(".txt")
                || lowerName.endsWith(".yaml")
                || lowerName.endsWith(".yml");
    }

    private static boolean containsNullByte(byte[] raw) {
        for (byte b : raw) {
            if (b == 0) return true;
        }
        return false;
    }

    private static void normalizeExtractedTree(File dir, boolean inExecDir, String homePath) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            String name = f.getName();
            if (f.isDirectory()) {
                boolean childExec = inExecDir || "bin".equals(name) || "scripts".equals(name);
                normalizeExtractedTree(f, childExec, homePath);
                continue;
            }
            String lowerName = name.toLowerCase(java.util.Locale.ROOT);
            boolean inBinDir = dir.getName().equals("bin");
            if (!inBinDir && isTextExtension(lowerName) && f.length() > 0 && f.length() < 1024 * 1024) {
                try {
                    byte[] raw = new byte[(int) f.length()];
                    try (FileInputStream fis = new FileInputStream(f)) {
                        int off = 0;
                        while (off < raw.length) {
                            int r = fis.read(raw, off, raw.length - off);
                            if (r <= 0) break;
                            off += r;
                        }
                    }
                    if (!containsNullByte(raw)) {
                        String txt = new String(raw, StandardCharsets.UTF_8);
                        if (txt.indexOf('\r') >= 0 || txt.contains("com.agy") || txt.contains("com.oc.ide")) {
                            String clean = txt.replace("\r\n", "\n")
                                    .replace("/data/user/0/com.agy/files/.gemini/config/plugins/",
                                            homePath + "/.codex/plugins-hub/")
                                    .replace("/data/user/0/com.agy/files", homePath)
                                    .replace("/data/data/com.agy/files", homePath)
                                    .replace("/data/user/0/com.oc.ide/files", homePath)
                                    .replace("/data/data/com.oc.ide/files", homePath);
                            AtomicFileWriter.writeText(f, clean);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
            if (inExecDir || lowerName.endsWith(".sh")) {
                FileModeUtil.setExec(f);
            }
        }
    }

    private static final java.util.regex.Pattern SAFE_PLUGIN_NAME =
            java.util.regex.Pattern.compile("^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$");

    private static String sanitizeName(String s) {
        if (s == null) return "";
        String trimmed = s.trim();
        if (".".equals(trimmed) || "..".equals(trimmed)) {
            return "";
        }
        if (SAFE_PLUGIN_NAME.matcher(trimmed).matches()) {
            return trimmed;
        }
        return "";
    }

    private static boolean isSymlink(File f) {
        if (f == null) return false;
        try {
            android.system.StructStat stat = android.system.Os.lstat(f.getAbsolutePath());
            return android.system.OsConstants.S_ISLNK(stat.st_mode);
        } catch (Throwable t) {
            return false;
        }
    }

    private static void copyRecursive(File src, File dst) throws Exception {
        if (isSymlink(src)) {
            Log.w(TAG, "Skipping symlink during copy: " + src);
            return;
        }
        if (src.isDirectory()) {
            dst.mkdirs();
            File[] children = src.listFiles();
            if (children != null) {
                for (File c : children) {
                    copyRecursive(c, new File(dst, c.getName()));
                }
            }
        } else if (src.isFile()) {
            copyFile(src, dst);
        }
    }

    private static void copyFile(File src, File dst) throws Exception {
        if (isSymlink(src) || isSymlink(dst)) {
            Log.w(TAG, "Refusing copy with symlink involved: src=" + src + " dst=" + dst);
            return;
        }
        File parent = dst.getParentFile();
        if (parent != null && !parent.isDirectory()) {
            parent.mkdirs();
        }
        try (FileInputStream in = new FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        try {
            if (android.system.Os.lstat(f.getAbsolutePath()).st_mode != 0
                    && android.system.OsConstants.S_ISLNK(android.system.Os.lstat(f.getAbsolutePath()).st_mode)) {
                f.delete();
                return;
            }
        } catch (Throwable ignored) {
        }
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) {
                deleteRecursive(c);
            }
        }
        f.delete();
    }

    private static JSONObject readJsonObject(File f) {
        if (f != null && f.isFile()) {
            try (FileInputStream fis = new FileInputStream(f)) {
                String txt = IoUtil.readAll(fis, "UTF-8").trim();
                if (!txt.isEmpty()) {
                    return new JSONObject(txt);
                }
            } catch (Exception ignored) {
            }
        }
        return new JSONObject();
    }
}
