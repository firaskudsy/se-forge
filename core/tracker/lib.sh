# Helpers for the tracker adapters; tracker.sh loads this file before the adapter.
# Everything here runs on macOS's bash 3.2: no associative arrays, and an array that may be empty is
# expanded as ${a[@]+"${a[@]}"}, because "${a[@]}" of an empty array aborts under set -u there.

# TRACKER_DRY_RUN=1 turns every change into a "DRY RUN: …" line on stderr.
tk_dry() { [[ "${TRACKER_DRY_RUN:-0}" == "1" ]]; }

# A status that finishes the work closes the ticket as well.
tk_closes() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in done|closed|resolved) return 0 ;; esac
  return 1
}

# tk_need <command> <adapter> [how to install]: stop when a command the adapter calls is missing.
tk_need() {
  if ! type -P "$1" >/dev/null; then
    echo "tracker($2): $1 is required${3:+ ($3)}" >&2
    exit 2
  fi
}

# tk_note <args after the id>: the text of a trailing `--comment "<text>"`, or nothing.
tk_note() { [[ "${1:-}" != "--comment" ]] || printf '%s' "${2:-}"; }

# The options of `create`, shared by every adapter. They land in tk_subject, tk_desc, tk_type, tk_status,
# tk_board, tk_column, tk_assignee (--assignee, else TRACKER_ASSIGNEE, else none), tk_relates (ticket ids) and
# tk_extra: "<scope> <value>" pairs for the labels --source, --area, --repo and --ready add, which each adapter
# writes in its own label syntax.
tk_create_args() {
  tk_subject='' tk_desc='' tk_type=Task tk_status=Todo tk_board='' tk_column=Pending tk_assignee="${TRACKER_ASSIGNEE:-}"
  tk_relates=() tk_extra=()
  while (( $# )); do
    case "$1" in
      --ready) tk_extra+=('ai ready'); shift; continue ;;
      --subject) tk_subject="$2" ;;
      --description) tk_desc="$2" ;;
      --description-file) tk_desc="$(<"$2")" ;;
      --type) tk_type="$2" ;;
      --status) tk_status="$2" ;;
      --relates) tk_relates+=("$2") ;;
      --board) tk_board="$2" ;;
      --column) tk_column="$2" ;;
      --assignee) tk_assignee="$2" ;;
      --source) tk_extra+=("source $2") ;;
      --area) tk_extra+=("area $2") ;;
      --repo) tk_extra+=("repo $2") ;;
      *) echo "tracker create: unknown option $1" >&2; return 1 ;;
    esac
    shift 2
  done
  [[ -n "$tk_subject" ]] && return 0
  echo "tracker create: --subject \"<title>\" is required (forge tracker help)" >&2
  return 1
}
