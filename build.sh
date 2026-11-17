#!/usr/bin/env bash
#
# build.sh - Codex for Android (v26.51111.1-r1) Gradle-free APK build orchestrator.
#
# Flags:
#   --dev           -> build side-by-side Dev edition (com.ce.dev, Codex Dev, port 45198)
#   --help          -> print usage
#
set -euo pipefail

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

for _p in \
    "/data/user/0/com.agy/files/usr/bin" \
    "/data/user/0/com.ce.ide/files/usr/bin" \
    "/data/user/0/com.cc.ide/files/usr/bin"; do
    if [ -d "$_p" ]; then
        export PATH="$_p:$PATH"
        break
    fi
done
unset _p

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT

. "$PROJECT/build/lib/log.sh"
. "$PROJECT/build/lib/flags.sh"
parse_args "$@"

. "$PROJECT/build/lib/paths.sh"
setup_paths

. "$PROJECT/build/lib/prereqs.sh"
check_tools

clean_build

shopt -s nullglob
for p in "$BUILD_LIB_DIR"/../phases/*.sh; do
    . "$p"
done
shopt -u nullglob
