package com.ce.ide.core;

import com.ce.ide.util.IoUtil;
import com.ce.ide.util.ProcessUtils;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Probes Codex Host loopback server readiness on GET /__ce_health?nonce=...
 * with HMAC-SHA256 mutual authentication so no impostor on the port can pass.
 */
public final class CoreReadyProbe {

    public static final long READY_TIMEOUT_MS = 45_000L;
    private static final SecureRandom RNG = new SecureRandom();

    private CoreReadyProbe() {
    }

    private static String randomHexNonce() {
        byte[] raw = new byte[16];
        RNG.nextBytes(raw);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : raw) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static String computeHmacHex(String secret, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] digest = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    public static boolean probeOnce(int port, String csrf) {
        if (csrf == null || csrf.isEmpty()) {
            ProcessUtils.sleep(120);
            return false;
        }
        HttpURLConnection conn = null;
        try {
            String nonce = randomHexNonce();
            String expectedHmac = computeHmacHex(csrf, nonce);
            URL url = new URL("http://127.0.0.1:" + port + "/__ce_health?nonce=" + nonce);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(800);
            conn.setReadTimeout(1200);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() == 200) {
                try (InputStream in = conn.getInputStream()) {
                    String body = IoUtil.readAll(in, "UTF-8");
                    JSONObject obj = new JSONObject(body);
                    String actualHmac = obj.optString("hmac", "");
                    if (obj.optBoolean("ok", false)
                            && actualHmac.length() == expectedHmac.length()
                            && MessageDigest.isEqual(
                                    actualHmac.getBytes(StandardCharsets.UTF_8),
                                    expectedHmac.getBytes(StandardCharsets.UTF_8))) {
                        return true;
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        ProcessUtils.sleep(120);
        return false;
    }

    public static void warmDefaultWorkspace(File workspaceDir) {
        if (workspaceDir != null && !workspaceDir.isDirectory()) {
            workspaceDir.mkdirs();
        }
    }
}
