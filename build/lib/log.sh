#!/usr/bin/env bash
#
# log.sh - logging primitives shared by every build stage.

log() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\n[FATAL] %s\n' "$*" >&2; exit 1; }
