#!/usr/bin/env bash
set -euo pipefail

WORLD="${1:-}"
if [[ -z "$WORLD" ]]; then
  echo "usage: validate-mcworld.sh <world.mcworld>" >&2
  exit 2
fi
if [[ ! -f "$WORLD" ]]; then
  echo "mcworld not found: $WORLD" >&2
  exit 1
fi
if [[ "$WORLD" != *.mcworld ]]; then
  echo "expected .mcworld extension: $WORLD" >&2
  exit 1
fi

BYTES="$(stat -c '%s' "$WORLD")"
if [[ "$BYTES" -lt 1024 ]]; then
  echo "mcworld is unexpectedly small: ${BYTES} bytes" >&2
  exit 1
fi

unzip -tqq "$WORLD"
ENTRIES="$(unzip -Z1 "$WORLD")"
if ! grep -Eq '(^|/)level\.dat$' <<<"$ENTRIES"; then
  echo "mcworld is missing level.dat" >&2
  exit 1
fi
if ! grep -Eq '(^|/)db/' <<<"$ENTRIES"; then
  echo "mcworld is missing the Bedrock LevelDB directory" >&2
  exit 1
fi

printf 'mcworld_validation=ok\n'
printf 'mcworld_bytes=%s\n' "$BYTES"
printf 'mcworld_sha256=%s\n' "$(sha256sum "$WORLD" | cut -d' ' -f1)"
