#!/usr/bin/env bash
#
# 04-runtime.sh - assemble assets/runtime/{bin,certs,seed,host,bundled-skills}.

log "[2/11] assemble assets/runtime/{bin,certs,seed,host,bundled-skills}"
mkdir -p "$RT/bin" "$RT/certs" "$RT/seed" "$RT/host" "$RT/bundled-skills"

for tool in "$TOOLS_SRC_DIR"/*; do
    [ -e "$tool" ] || continue
    cp -f "$tool" "$RT/bin/"
done

cp -r "$HOST_SRC_DIR/." "$RT/host/"
cp -r "$SKILLS_SRC_DIR/." "$RT/bundled-skills/"
cp -f "$CERTS_DIR"/* "$RT/certs/"
cp -f "$SEED_DIR"/* "$RT/seed/"
chmod 755 "$RT/bin"/* "$RT/host/codex-serve.cjs" 2>/dev/null || true
