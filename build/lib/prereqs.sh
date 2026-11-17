#!/usr/bin/env bash
#
# prereqs.sh - host tool + input existence checks and build scratch cleanup.

need() { command -v "$1" >/dev/null 2>&1 || die "missing host tool: $1"; }

check_tools() {
    for t in aapt javac java zipalign apksigner zip unzip python3 sha256sum gzip file mktemp; do
        need "$t"
    done

    [ -f "$CORE_ARCHIVE_SRC" ]                 || die "Codex core archive not found: $CORE_ARCHIVE_SRC"
    [ -f "$WEBVIEW_PAK_SRC" ]                  || die "webview-bundle.pak not found: $WEBVIEW_PAK_SRC"
    [ -f "$HOST_SRC_DIR/codex-serve.cjs" ]     || die "Codex host server not found: $HOST_SRC_DIR/codex-serve.cjs"
    [ -f "$HOST_SRC_DIR/extension.js" ]        || die "Official OpenAI extension.js not found: $HOST_SRC_DIR/extension.js"
    [ -f "$HOST_SRC_DIR/webview/index.html" ]  || die "Official OpenAI webview/index.html not found: $HOST_SRC_DIR/webview/index.html"
    [ -f "$HOST_SRC_DIR/webview-index.json" ]  || die "webview-index.json not found: $HOST_SRC_DIR/webview-index.json"
    [ -d "$SKILLS_SRC_DIR" ]                   || die "Bundled skills directory not found: $SKILLS_SRC_DIR"
    [ -f "$CERTS_DIR/ca-certificates.crt" ]    || die "CA bundle not found: $CERTS_DIR/ca-certificates.crt"
    [ -f "$SEED_DIR/AGENTS.md" ]               || die "Seed AGENTS.md not found: $SEED_DIR/AGENTS.md"
    [ -f "$TOOLS_SRC_DIR/codex-host" ]         || die "codex-host launcher not found: $TOOLS_SRC_DIR/codex-host"
    [ -f "$TOOLS_SRC_DIR/codex" ]              || die "codex wrapper not found: $TOOLS_SRC_DIR/codex"
    [ -f "$TOOLS_SRC_DIR/node" ]               || die "node wrapper not found: $TOOLS_SRC_DIR/node"
    [ -f "$TOOLS_SRC_DIR/rish" ]               || die "Shizuku rish script not found: $TOOLS_SRC_DIR/rish"
    [ -f "$ANDROID_JAR" ]                      || die "android.jar not found: $ANDROID_JAR"
    [ -f "$R8_JAR" ]                           || die "r8.jar not found: $R8_JAR"
    [ -f "$KEYSTORE" ]                         || die "keystore not found: $KEYSTORE"
    [ -f "$MANIFEST_XML" ]                     || die "AndroidManifest.xml not found: $MANIFEST_XML"
    [ -d "$WEB_DIR" ]                          || die "web/ directory not found: $WEB_DIR"
    [ -f "$GEN_ANDROID_CONFIG" ]               || die "gen_android_config.py not found: $GEN_ANDROID_CONFIG"
}

clean_build() {
    log "clean build scratch directories"
    rm -rf "$BUILD_DIR/staging" "$BUILD_DIR/gen" "$BUILD_DIR/obj" "$BUILD_DIR/dex" \
           "$BUILD_DIR/apk" "$BUILD_DIR/res" "$BUILD_DIR/AndroidManifest.xml" \
           "$BUILD_DIR/unaligned.apk" "$BUILD_DIR/unaligned.apk.tmp" \
           "$BUILD_DIR/aligned.apk" "$BUILD_DIR/bootstrap.tar.gz.hold" \
           "$BUILD_DIR/codex-core.tar.gz.hold" "$BUILD_DIR/webview-bundle.pak.hold"
    mkdir -p "$BUILD_DIR/staging" "$BUILD_DIR/gen" "$BUILD_DIR/obj" "$BUILD_DIR/dex" \
             "$STAGE_ASSETS" "$DIST_DIR"
}
