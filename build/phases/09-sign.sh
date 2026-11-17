#!/usr/bin/env bash
#
# 09-sign.sh - zipalign and sign the APK with pure v2/v3 signatures.

log "[10/11] zipalign + apksigner sign"
zipalign -f -p 4 "$BUILD_DIR/unaligned.apk" "$BUILD_DIR/aligned.apk"

SIGN_KS="$KEYSTORE"
SIGN_ALIAS="$KEY_ALIAS"
SIGN_STORE_PASS="$STORE_PASS"
SIGN_KEY_PASS="$KEY_PASS"

if [ "${DEV_MODE:-0}" -eq 0 ]; then
    REL_ENV="${CE_RELEASE_KEYSTORE_ENV:-${SIGNING_ENV:-}}"
    if [ -z "$REL_ENV" ] && [ -f "$(dirname "$PROJECT")/.codex-keystore/keystore.env" ]; then
        REL_ENV="$(dirname "$PROJECT")/.codex-keystore/keystore.env"
    elif [ -z "$REL_ENV" ] && [ -n "${HOME:-}" ] && [ -f "$HOME/.config/codex-keystore/keystore.env" ]; then
        REL_ENV="$HOME/.config/codex-keystore/keystore.env"
    fi
    if [ -n "$REL_ENV" ] && [ -f "$REL_ENV" ]; then
        # shellcheck disable=SC1090
        . "$REL_ENV"
    fi
    if [ -n "${CE_RELEASE_KEYSTORE:-}" ] && [ -f "${CE_RELEASE_KEYSTORE}" ]; then
        SIGN_KS="$CE_RELEASE_KEYSTORE"
        SIGN_ALIAS="${CE_RELEASE_KEY_ALIAS:-codex_release}"
        SIGN_STORE_PASS="${CE_RELEASE_STORE_PASS:-}"
        SIGN_KEY_PASS="${CE_RELEASE_KEY_PASS:-$SIGN_STORE_PASS}"
        log "  Signing RELEASE APK with dedicated Codex production keystore ($SIGN_ALIAS)"
    elif [ -n "${KEYSTORE:-}" ] && [ -f "${KEYSTORE}" ] && [ "${KEY_ALIAS:-}" != "androiddebugkey" ]; then
        SIGN_KS="$KEYSTORE"
        SIGN_ALIAS="${KEY_ALIAS}"
        SIGN_STORE_PASS="${STORE_PASS}"
        SIGN_KEY_PASS="${KEY_PASS:-$STORE_PASS}"
        log "  Signing RELEASE APK with production keystore ($SIGN_ALIAS)"
    else
        log "  Signing APK with local fallback keystore ($SIGN_ALIAS)"
    fi
else
    log "  Signing DEV APK with debug keystore ($SIGN_ALIAS)"
fi

if [ ! -f "$SIGN_KS" ]; then
    if [ "$SIGN_ALIAS" = "androiddebugkey" ]; then
        mkdir -p "$(dirname "$SIGN_KS")"
        keytool -genkeypair \
            -keystore "$SIGN_KS" \
            -storetype PKCS12 \
            -alias "$SIGN_ALIAS" \
            -keyalg RSA \
            -keysize 2048 \
            -validity 10000 \
            -storepass "$SIGN_STORE_PASS" \
            -keypass "$SIGN_KEY_PASS" \
            -dname "CN=Local Dev Build, O=CodexAndroid" >/dev/null 2>&1
    else
        die "Configured release keystore not found: $SIGN_KS"
    fi
fi

apksigner sign \
    --v1-signing-enabled false \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --ks "$SIGN_KS" \
    --ks-key-alias "$SIGN_ALIAS" \
    --ks-pass "pass:$SIGN_STORE_PASS" \
    --key-pass "pass:$SIGN_KEY_PASS" \
    --out "$OUT_APK" \
    "$BUILD_DIR/aligned.apk"
