#!/usr/bin/env bash
# The OpenProject API key, found without printing it and without putting it in any command's arguments.
# Sourced by adapters/openproject.sh, and by forge doctor to learn which source holds it (its name only).
# First hit wins:
#   1. OPENPROJECT_API_KEY in the environment
#   2. macOS Keychain:   security find-generic-password -s se-forge-openproject -a "$USER" -w
#   3. Linux keyring:    secret-tool lookup service se-forge-openproject
#   4. a file:           ${XDG_CONFIG_HOME:-$HOME/.config}/se-forge/openproject-key, readable by its owner only
#                        (the permission check is skipped on Git Bash/MSYS/Cygwin, where modes mean nothing)
# op_find_key sets OPENPROJECT_API_KEY and op_key_source, or prints why not and fails.

op_key_file() { printf '%s/se-forge/openproject-key' "${XDG_CONFIG_HOME:-$HOME/.config}"; }

op_find_key() {
  local key="" file
  op_key_source=""
  if [[ -n "${OPENPROJECT_API_KEY:-}" ]]; then op_key_source="env OPENPROJECT_API_KEY"; return 0; fi
  if command -v security >/dev/null 2>&1; then
    key="$(security find-generic-password -s se-forge-openproject -a "${USER:-$(id -un)}" -w 2>/dev/null)" || key=""
    [[ -z "$key" ]] || op_key_source="macOS Keychain (se-forge-openproject)"
  fi
  if [[ -z "$key" ]] && command -v secret-tool >/dev/null 2>&1; then
    key="$(secret-tool lookup service se-forge-openproject 2>/dev/null)" || key=""
    [[ -z "$key" ]] || op_key_source="Secret Service (secret-tool, service se-forge-openproject)"
  fi
  file="$(op_key_file)"
  if [[ -z "$key" && -f "$file" ]]; then
    case "$(uname -s 2>/dev/null)" in
      MINGW*|MSYS*|CYGWIN*) ;;
      *) if [[ -n "$(find "$file" \( -perm -040 -o -perm -004 \) 2>/dev/null)" ]]; then
           echo "tracker(openproject): $file is readable by others; refusing it. Run: chmod 600 \"$file\"" >&2
           return 1
         fi ;;
    esac
    key="$(head -n 1 "$file" | tr -d '\r\n')"
    [[ -z "$key" ]] || op_key_source="file $file"
  fi
  if [[ -z "$key" ]]; then
    echo "tracker(openproject): no API key found. Looked in: the OPENPROJECT_API_KEY environment variable; the macOS Keychain (service se-forge-openproject); the Linux keyring (secret-tool, service se-forge-openproject); the file $file (chmod 600). See GUIDE.md, Configuration." >&2
    return 1
  fi
  OPENPROJECT_API_KEY="$key"
}
