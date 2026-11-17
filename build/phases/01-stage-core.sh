#!/usr/bin/env bash
#
# 01-stage-core.sh - stage & verify Codex ARM64 core archive + indexed webview-bundle.pak.

log "[1/11] stage & verify Codex ARM64 core archive + webview-bundle.pak"

for _large_src in "$CORE_ARCHIVE_SRC" "$WEBVIEW_PAK_SRC"; do
    if [ ! -f "$_large_src" ]; then
        shopt -s nullglob
        _parts=( "${_large_src}".part-* )
        shopt -u nullglob
        [ "${#_parts[@]}" -gt 0 ] \
            || die "archive missing: $_large_src (and no .part-* chunks found)"
        log "  reassembling $(basename "$_large_src") from ${#_parts[@]} repository chunks..."
        cat "${_parts[@]}" > "${_large_src}.tmp"
        mv -f "${_large_src}.tmp" "$_large_src"
    fi
    if [ -f "${_large_src}.sha256" ]; then
        _exp_sha="$(awk '{print $1}' "${_large_src}.sha256")"
        _act_sha="$(sha256sum "$_large_src" | awk '{print $1}')"
        [ "$_exp_sha" = "$_act_sha" ] \
            || die "$(basename "$_large_src") SHA-256 mismatch: expected $_exp_sha, got $_act_sha"
    fi
done
unset _large_src _parts _exp_sha _act_sha

[ -f "$CORE_ARCHIVE_SRC" ] || die "core archive missing: $CORE_ARCHIVE_SRC"
[ -f "$WEBVIEW_PAK_SRC" ] || die "webview-bundle.pak missing: $WEBVIEW_PAK_SRC"

file -b "$CORE_ARCHIVE_SRC" | grep -q '^gzip compressed' \
    || die "core archive is not gzip compressed: $CORE_ARCHIVE_SRC"

mkdir -p "$(dirname "$STAGED_CORE_ARCHIVE")" "$RT"

if [ "$DEV_MODE" -eq 1 ] && [ "${#PKG}" -eq "${#PKG_DEV}" ]; then
    log "  --dev: rewriting 10-byte prefix $PKG -> $PKG_DEV inside staged codex-core.tar.gz"
    python3 - "$CORE_ARCHIVE_SRC" "$STAGED_CORE_ARCHIVE" "$PKG" "$PKG_DEV" <<'PY'
import gzip, io, os, sys, tarfile, tempfile

src_tgz, dst_tgz, src_pkg, dst_pkg = sys.argv[1], sys.argv[2], sys.argv[3].encode(), sys.argv[4].encode()
assert len(src_pkg) == len(dst_pkg)

with tarfile.open(src_tgz, "r:gz") as tin, gzip.GzipFile(dst_tgz, "wb", compresslevel=6, mtime=0) as gz:
    with tarfile.open(mode="w", fileobj=gz) as tout:
        for m in tin.getmembers():
            if m.isfile():
                fobj = tin.extractfile(m)
                if m.name.endswith(("codex.elf", "codex-code-mode-host")):
                    # Stream-rewrite 10-byte com.ce.ide -> com.ce.dev in chunks
                    with tempfile.NamedTemporaryFile(delete=False) as tf:
                        tmp_name = tf.name
                        carry = b""
                        while True:
                            chunk = fobj.read(4 * 1024 * 1024)
                            if not chunk:
                                if carry:
                                    tf.write(carry.replace(src_pkg, dst_pkg))
                                break
                            buf = carry + chunk
                            safe_end = len(buf) - len(src_pkg)
                            if safe_end > 0:
                                head, carry = buf[:safe_end], buf[safe_end:]
                                tf.write(head.replace(src_pkg, dst_pkg))
                            else:
                                carry = buf
                    with open(tmp_name, "rb") as rf:
                        tout.addfile(m, rf)
                    os.unlink(tmp_name)
                else:
                    raw = fobj.read().replace(src_pkg, dst_pkg)
                    m.size = len(raw)
                    tout.addfile(m, io.BytesIO(raw))
            else:
                tout.addfile(m)
PY
else
    cp -f "$CORE_ARCHIVE_SRC" "$STAGED_CORE_ARCHIVE"
fi

cp -f "$WEBVIEW_PAK_SRC" "$STAGED_WEBVIEW_PAK"

gzip -t "$STAGED_CORE_ARCHIVE" || die "staged codex-core.tar.gz failed gzip integrity test"
CORE_SHA256="$(sha256sum "$STAGED_CORE_ARCHIVE" | awk '{print $1}')"
printf '%s\n' "$CORE_SHA256" > "$RT/core-archive.sha256"
log "  staged codex-core.tar.gz ok (sha256=${CORE_SHA256:0:16}...)"
