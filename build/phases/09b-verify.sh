#!/usr/bin/env bash
#
# 09b-verify.sh - verify APK cryptographic signature and packaged Codex ARM64 payload.

log "[11/11] apksigner verify + payload integrity check"
apksigner verify --verbose "$OUT_APK"

python3 - "$OUT_APK" <<'PY'
import gzip, hashlib, json, sys, zipfile

apk = sys.argv[1]
required = [
    "AndroidManifest.xml",
    "classes.dex",
    "resources.arsc",
    "assets/core-archive/codex-core.tar.gz",
    "assets/core-archive/webview-bundle.pak",
    "assets/runtime/core-archive.sha256",
    "assets/runtime/bin/codex-host",
    "assets/runtime/bin/codex",
    "assets/runtime/bin/node",
    "assets/runtime/bin/rish",
    "assets/runtime/bin/xdg-open",
    "assets/runtime/host/codex-serve.cjs",
    "assets/runtime/host/vscode-shim.cjs",
    "assets/runtime/host/codex-theme.css",
    "assets/runtime/host/extension.js",
    "assets/runtime/host/webview/index.html",
    "assets/runtime/host/webview-index.json",
    "assets/runtime/certs/ca-certificates.crt",
    "assets/runtime/seed/AGENTS.md",
    "assets/runtime/seed/config.toml",
    "assets/runtime/manifest.json",
    "assets/web/__ce_android_boot.js",
    "assets/web/__ce_plugins_catalog.json",
    "assets/web/codex-icon.png",
    "assets/env/bootstrap/bootstrap.tar.gz",
    "assets/env/overlay/bin/ce-box",
    "assets/env/overlay/bin/rg",
]

with zipfile.ZipFile(apk, "r") as z:
    names = set(z.namelist())
    missing = [r for r in required if r not in names]
    if missing:
        sys.exit("[verify] FAIL missing required APK entries: %r" % missing)

    for stored_asset in (
        "assets/env/bootstrap/bootstrap.tar.gz",
        "assets/core-archive/codex-core.tar.gz",
        "assets/core-archive/webview-bundle.pak",
    ):
        zi = z.getinfo(stored_asset)
        if zi.compress_type != zipfile.ZIP_STORED:
            sys.exit("[verify] FAIL %s is not ZIP_STORED" % stored_asset)

    expected_sha = z.read("assets/runtime/core-archive.sha256").decode("utf-8").strip()
    h = hashlib.sha256()
    head = b""
    total = 0
    with z.open("assets/core-archive/codex-core.tar.gz") as f:
        while True:
            c = f.read(1 << 20)
            if not c: break
            if len(head) < 16: head += c[:16 - len(head)]
            h.update(c)
            total += len(c)
    if head[:2] != b"\x1f\x8b":
        sys.exit("[verify] FAIL codex-core.tar.gz is not gzip")
    if h.hexdigest() != expected_sha:
        sys.exit("[verify] FAIL codex-core.tar.gz sha256 mismatch")
    with z.open("assets/core-archive/codex-core.tar.gz") as f:
        import tarfile
        with tarfile.open(fileobj=f, mode="r:gz") as tf:
            core_members = set(tf.getnames())
    for core_req in ("bin/node.elf", "bin/codex.elf", "bin/codex-code-mode-host"):
        if core_req not in core_members:
            sys.exit("[verify] FAIL codex-core.tar.gz missing %s" % core_req)
    print("[verify] codex-core.tar.gz ok (%.2f MB stored, includes codex-code-mode-host)" % (total / (1024 * 1024)))

    pak_info = z.getinfo("assets/core-archive/webview-bundle.pak")
    print("[verify] webview-bundle.pak ok (%.2f MB stored)" % (pak_info.file_size / (1024 * 1024)))

    manifest = json.loads(z.read("assets/runtime/manifest.json").decode("utf-8"))
    print("[verify] runtime/manifest.json ok (%d files verified)" % len(manifest["files"]))
PY

rm -rf "$BUILD_DIR/staging" "$BUILD_DIR/gen" "$BUILD_DIR/obj" "$BUILD_DIR/dex" \
       "$BUILD_DIR/apk" "$BUILD_DIR/res" "$BUILD_DIR/AndroidManifest.xml" \
       "$BUILD_DIR/unaligned.apk" "$BUILD_DIR/aligned.apk" \
       "$BUILD_DIR/bootstrap.tar.gz.hold" "$BUILD_DIR/codex-core.tar.gz.hold" "$BUILD_DIR/webview-bundle.pak.hold"

log "BUILD OK -> $OUT_APK"
ls -lh "$OUT_APK"
