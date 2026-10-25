#!/usr/bin/env bash
# `forge tracker <command>` runs this file with FORGE_TRACKER taken from project.tracker. It loads lib.sh
# and adapters/<FORGE_TRACKER>.sh, which defines tr_<command> for each command in the help below.
# An adapter reads its credentials itself, by variable name, and never prints them.
set -uo pipefail

help() {
  cat <<'HELP'
forge tracker: read and change tickets on the project's tracker (GitHub, GitLab or OpenProject).

Read:
  get <id> [--json]                       title, state, labels, assignee and description of one ticket
  list board [<board>]                    each status with its open tickets
  list status "<status>"                  the tickets in one status, open or closed
  list open                               the open tickets
  list ready                              the open tickets the leader may take (label ai::ready or ai:ready;
                                          on OpenProject, the status OPENPROJECT_READY_STATUS)
  list json                               the open tickets with their dates, for triage
  statuses                                how this tracker spells its statuses and types

Change:
  create --subject "<title>" [--description "<text>" | --description-file <file>] [--type Task]
         [--status Todo] [--relates <id>]... [--board issues|frontend|<board> --column Pending]
         [--source ai] [--area ui|api|db|infra]... [--repo <name>] [--ready] [--assignee "<name>"]
                                          --repo: in a system, the repository the ticket changes (decision 131)
                                          --assignee: else TRACKER_ASSIGNEE, else unassigned
  assign <id> "<name>"                    set the assignee (OpenProject: the user's name; GitLab/GitHub: username)
  status <id> "<status>" [--comment "<text>"]   Done, Closed and Resolved also close the ticket
  comment <id> "<text>"  |  comment <id> --file <file>
  ready <id> [--comment "<why>"]          hand it to the leader (project-manager, bugs only)

With TRACKER_DRY_RUN=1, a change prints the commands it would run and runs none.
HELP
}

case "${1:-help}" in help|-h|--help) help; exit 0 ;; esac

if [[ ! "${FORGE_TRACKER:-}" =~ ^[a-z]+$ ]]; then
  echo "tracker: FORGE_TRACKER is '${FORGE_TRACKER:-}'; run this as forge tracker <command>, with project.tracker set to github, gitlab or openproject" >&2
  exit 2
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$here/adapters/$FORGE_TRACKER.sh" ]]; then
  echo "tracker: no adapter for '$FORGE_TRACKER' in $here/adapters; set project.tracker (or FORGE_TRACKER) to github, gitlab or openproject" >&2
  exit 2
fi
# shellcheck source=lib.sh
. "$here/lib.sh"
# shellcheck disable=SC1090
. "$here/adapters/$FORGE_TRACKER.sh"

command="$1"; shift
case "$command" in
  get|list|create|status|comment|statuses|ready|assign) "tr_$command" "$@" ;;
  *) echo "tracker: '$command' is not a tracker command (forge tracker help lists them)" >&2; exit 1 ;;
esac
