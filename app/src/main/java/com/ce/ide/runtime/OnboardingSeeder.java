package com.ce.ide.runtime;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import com.ce.ide.util.AtomicFileWriter;
import com.ce.ide.util.IoUtil;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * Seeds Codex Android user configuration on launch:
 *  - ~/.codex/config.toml (sandbox_mode = "danger-full-access")
 *  - ~/.codex/AGENTS.md & /storage/emulated/0/Documents/Codex/AGENTS.md
 *  - ~/.agents/skills/* (official bundled skills)
 *  - ~/.gitconfig (safe.directory = *)
 */
public final class OnboardingSeeder {

    private static final String TAG = "OnboardingSeeder";

    private OnboardingSeeder() {
    }

    public static void seed(Context context, File codexDir, File sessionsDir, int port, String csrfToken) {
        try {
            File filesDir = context.getFilesDir();
            mkdirsQuiet(codexDir);
            mkdirsQuiet(sessionsDir);
            mkdirsQuiet(new File(codexDir, "skills"));
            mkdirsQuiet(new File(codexDir, "plugins-hub"));
            mkdirsQuiet(new File(filesDir, ".agents/skills"));

            ensureCodexConfigToml(codexDir);
            seedBundledAgentsMd(context, new File(codexDir, "AGENTS.md"));

            try {
                File defaultWs = new File(Environment.getExternalStorageDirectory(), "Documents/Codex");
                if ((defaultWs.isDirectory() || defaultWs.mkdirs()) && defaultWs.canWrite()) {
                    File wsAgentsMd = new File(defaultWs, "AGENTS.md");
                    if (!wsAgentsMd.isFile()) {
                        seedBundledAgentsMd(context, wsAgentsMd);
                    }
                }
            } catch (Throwable ignored) {
            }

            seedBundledSkills(filesDir, new File(filesDir, ".agents/skills"));
            ensureGitSafeDirectory(filesDir);
        } catch (Exception e) {
            Log.w(TAG, "OnboardingSeeder notice: " + e.getMessage());
        }
    }

    private static void ensureCodexConfigToml(File codexDir) {
        try {
            File cfg = new File(codexDir, "config.toml");
            if (!cfg.isFile() || cfg.length() == 0) {
                AtomicFileWriter.writeText(cfg,
                        "# Codex for Android — Native ARM64 Configuration\n"
                                + "sandbox_mode = \"danger-full-access\"\n\n"
                                + "[features]\n"
                                + "code_mode_host = true\n");
                return;
            }
            String cur;
            try (FileInputStream fis = new FileInputStream(cfg)) {
                cur = IoUtil.readAll(fis, "UTF-8");
            }
            String updated = cur
                    .replaceAll("(?m)^\\s*code_mode_host\\s*=\\s*false\\s*$", "code_mode_host = true")
                    .replaceAll("(?m)^\\s*code_mode\\s*=\\s*false\\s*\\r?\\n?", "")
                    .replaceAll("(?m)^\\s*code_mode_only\\s*=\\s*false\\s*\\r?\\n?", "");
            if (!updated.equals(cur)) {
                AtomicFileWriter.writeText(cfg, updated);
            }
        } catch (Exception ignored) {
        }
    }

    private static void seedBundledAgentsMd(Context ctx, File dst) {
        try (InputStream in = ctx.getAssets().open(RuntimePaths.SEED_ASSET + "/AGENTS.md")) {
            String raw = IoUtil.readAll(in, "UTF-8");
            String pkg = ctx.getPackageName();
            if (!"com.ce.ide".equals(pkg)) {
                raw = raw.replace("com.ce.ide", pkg);
            }
            if (!dst.isFile() || dst.length() == 0) {
                AtomicFileWriter.writeText(dst, raw);
            }
        } catch (Exception e) {
            Log.w(TAG, "cannot seed AGENTS.md: " + e.getMessage());
        }
    }

    private static void seedBundledSkills(File filesDir, File dstSkillsDir) {
        try {
            File srcRoot = new File(filesDir, "runtime/bundled-skills");
            if (!srcRoot.isDirectory()) return;
            mkdirsQuiet(dstSkillsDir);
            File[] children = srcRoot.listFiles();
            if (children == null) return;
            for (File child : children) {
                if (!child.isDirectory()) continue;
                File target = new File(dstSkillsDir, child.getName());
                if (!target.exists()) {
                    copyTree(child, target);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private static void copyTree(File src, File dst) throws Exception {
        if (src.isDirectory()) {
            mkdirsQuiet(dst);
            File[] items = src.listFiles();
            if (items != null) {
                for (File it : items) {
                    copyTree(it, new File(dst, it.getName()));
                }
            }
            return;
        }
        mkdirsQuiet(dst.getParentFile());
        try (FileInputStream in = new FileInputStream(src);
             FileOutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    private static void ensureGitSafeDirectory(File filesDir) {
        try {
            File gitConfig = new File(filesDir, ".gitconfig");
            if (gitConfig.isFile()) {
                try (FileInputStream fis = new FileInputStream(gitConfig)) {
                    String cur = IoUtil.readAll(fis, "UTF-8");
                    if (cur.contains("directory = *")) return;
                }
            }
            AtomicFileWriter.writeText(gitConfig, "[safe]\n\tdirectory = *\n");
        } catch (Exception ignored) {
        }
    }

    private static void mkdirsQuiet(File dir) {
        if (dir != null && !dir.isDirectory()) {
            dir.mkdirs();
        }
    }
}
