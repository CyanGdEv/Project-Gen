#!/usr/bin/env bash
set -euo pipefail

# GitHub-hosted runners do not have SSH credentials/known_hosts for arbitrary
# dependency fetches. The temporary public Bedrock compiler and its public git
# dependencies must therefore use HTTPS. This preserves host/TLS verification;
# it does not disable SSH host-key checks.
KEY='url.https://github.com/.insteadOf'

git config --global --unset-all "$KEY" >/dev/null 2>&1 || true
git config --global --add "$KEY" 'git@github.com:'
git config --global --add "$KEY" 'ssh://git@github.com/'
git config --global --add "$KEY" 'git+ssh://git@github.com/'
git config --global --add "$KEY" 'git://github.com/'

mapfile -t rewrites < <(git config --global --get-all "$KEY")
expected=(
  'git@github.com:'
  'ssh://git@github.com/'
  'git+ssh://git@github.com/'
  'git://github.com/'
)

if [[ ${#rewrites[@]} -ne ${#expected[@]} ]]; then
  echo "expected ${#expected[@]} GitHub transport rewrites, found ${#rewrites[@]}" >&2
  exit 1
fi

for value in "${expected[@]}"; do
  found=false
  for actual in "${rewrites[@]}"; do
    if [[ "$actual" == "$value" ]]; then
      found=true
      break
    fi
  done
  if [[ "$found" != true ]]; then
    echo "missing GitHub HTTPS rewrite for: $value" >&2
    exit 1
  fi
done

printf 'Compiler GitHub dependency transport is HTTPS-normalized (%s rewrite forms).\n' "${#rewrites[@]}"
