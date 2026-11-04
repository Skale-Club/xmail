#!/usr/bin/env bash
# Read-only loader for the exact already-reviewed V2 source protocol. No eval,
# shell sourcing or duplication of its JavaScript/SQL bodies is necessary.
load_xmail_v2_protocol() {
  local protocol=$1 checksum name marker block
  [[ -f $protocol && ! -L $protocol ]] || return 2
  checksum=$(sha256sum <"$protocol" | awk '{print $1}')
  [[ $checksum == 154b8a09399548daed7ebe73df758a1f9b4ee5d44bcd5fea1f1ac2d4f297fdd2 ]] || return 2
  for name in ca_program environment_program manifest_sql holder_program compare_program; do
    marker=NODE; [[ $name != manifest_sql ]] || marker=SQL
    block=$(awk -v name="$name" -v marker="$marker" '
      $0 == name "=$(cat <<\047" marker "\047" { if (found) exit 2; inside=1; found=1; next }
      inside && $0 == marker { inside=0; closed=1; exit }
      inside { print }
      END { if (!found || !closed) exit 2 }
    ' "$protocol") || return 2
    [[ ${#block} -ge 100 && ${#block} -le 45000 ]] || return 2
    printf -v "$name" '%s' "$block"
  done
}
