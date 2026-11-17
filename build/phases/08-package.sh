#!/usr/bin/env bash
#
# 08-package.sh - package resources + assets + classes.dex + stored archives.

log "[9/11] aapt: package unaligned.apk + classes.dex + stored archives"

BOOTSTRAP_HOLD="$BUILD_DIR/bootstrap.tar.gz.hold"
BOOTSTRAP_ASSET_REL="assets/env/bootstrap/bootstrap.tar.gz"
HAS_BOOTSTRAP=0
if [ -f "$STAGE_APK/$BOOTSTRAP_ASSET_REL" ]; then
    mv -f "$STAGE_APK/$BOOTSTRAP_ASSET_REL" "$BOOTSTRAP_HOLD"
    HAS_BOOTSTRAP=1
fi

CORE_HOLD="$BUILD_DIR/codex-core.tar.gz.hold"
CORE_ASSET_REL="assets/core-archive/codex-core.tar.gz"
HAS_CORE=0
if [ -f "$STAGE_APK/$CORE_ASSET_REL" ]; then
    mv -f "$STAGE_APK/$CORE_ASSET_REL" "$CORE_HOLD"
    HAS_CORE=1
fi

PAK_HOLD="$BUILD_DIR/webview-bundle.pak.hold"
PAK_ASSET_REL="assets/core-archive/webview-bundle.pak"
HAS_PAK=0
if [ -f "$STAGE_APK/$PAK_ASSET_REL" ]; then
    mv -f "$STAGE_APK/$PAK_ASSET_REL" "$PAK_HOLD"
    HAS_PAK=1
fi

aapt package -f \
    --min-sdk-version "$MIN_API" \
    --target-sdk-version "$TARGET_SDK" \
    -M "$TARGET_MANIFEST" \
    -S "$TARGET_RES" \
    -I "$ANDROID_JAR" \
    -A "$STAGE_ASSETS" \
    -F "$BUILD_DIR/unaligned.apk"

( cd "$DEX_DIR" && zip -q -u "$BUILD_DIR/unaligned.apk" classes*.dex )

if [ "$HAS_BOOTSTRAP" -eq 1 ]; then
    mkdir -p "$(dirname "$STAGE_APK/$BOOTSTRAP_ASSET_REL")"
    mv -f "$BOOTSTRAP_HOLD" "$STAGE_APK/$BOOTSTRAP_ASSET_REL"
    zip -q -d "$BUILD_DIR/unaligned.apk" "assets/env/bootstrap/bootstrap.tar" >/dev/null 2>&1 || true
    ( cd "$STAGE_APK" && zip -q -0 -u "$BUILD_DIR/unaligned.apk" "$BOOTSTRAP_ASSET_REL" )
fi

if [ "$HAS_CORE" -eq 1 ]; then
    mkdir -p "$(dirname "$STAGE_APK/$CORE_ASSET_REL")"
    mv -f "$CORE_HOLD" "$STAGE_APK/$CORE_ASSET_REL"
    zip -q -d "$BUILD_DIR/unaligned.apk" "assets/core-archive/codex-core.tar" >/dev/null 2>&1 || true
    ( cd "$STAGE_APK" && zip -q -0 -u "$BUILD_DIR/unaligned.apk" "$CORE_ASSET_REL" )
fi

if [ "$HAS_PAK" -eq 1 ]; then
    mkdir -p "$(dirname "$STAGE_APK/$PAK_ASSET_REL")"
    mv -f "$PAK_HOLD" "$STAGE_APK/$PAK_ASSET_REL"
    ( cd "$STAGE_APK" && zip -q -0 -u "$BUILD_DIR/unaligned.apk" "$PAK_ASSET_REL" )
fi
