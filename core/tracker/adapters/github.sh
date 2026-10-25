#!/usr/bin/env bash
# GitHub, through the gh CLI.
# - A ticket is an issue. Its status is its single `status:<Name>` label and its type a `type:<Name>`
#   label; Done, Closed and Resolved close it. A related ticket is a "Relates to #<id>" line in the body.
# - --board places the card on a Projects (v2) board: the issue is added and its Status field set to the column.
# gh signs in by itself (GH_TOKEN or `gh auth login`). The board settings come from the environment, or
# else from .env.local by name, and are never printed:
#   GH_REPO                     owner/repo, for when gh cannot tell it from the git remote
#   GH_PROJECT_OWNER            the user or organisation that owns the board
#   GH_PROJECT_NUMBER           the board's number; GH_PROJECT_ISSUES_NUMBER and GH_PROJECT_FRONTEND_NUMBER
#                               give --board issues and --board frontend their own
tk_need gh github 'brew install gh; gh auth login'
tk_need jq github

gh_env_file="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")/.env.local"
for name in GH_REPO GH_PROJECT_OWNER GH_PROJECT_NUMBER GH_PROJECT_ISSUES_NUMBER GH_PROJECT_FRONTEND_NUMBER; do
  value="${!name:-}"
  # Only this name's line is read from .env.local; the value goes to gh, never to the output.
  [[ -n "$value" || ! -f "$gh_env_file" ]] || value="$(sed -n "s/^$name=//p" "$gh_env_file" | head -n 1 | tr -d "\"'")"
  export "$name=$value"
done
unset name value

gh_repo=()
[[ -z "$GH_REPO" ]] || gh_repo=(--repo "$GH_REPO")
gh_read() { gh "$@" ${gh_repo[@]+"${gh_repo[@]}"}; }
gh_write() {
  if tk_dry; then echo "DRY RUN: gh $*" >&2; return 0; fi
  gh_read "$@"
}
gh_issues() { gh_read issue list --limit 200 "$@"; }
gh_labels() { gh_read label list --limit 200 --json name | jq -r '.[].name'; }

# jq pieces: the assignees, and a ticket line with its status.
gh_who='([.assignees[].login] | join(","))'
gh_line='"#\(.number) \(.title)  [\([.labels[].name | select(startswith("status:")) | .[7:]] | join(","))]  \('"$gh_who"')"'

tr_get() {
  local id="${1:?forge tracker get needs a ticket id}" fields=number,title,state,labels,assignees,url,body
  if [[ "${2:-}" == "--json" ]]; then gh_read issue view "$id" --json "$fields,comments"; return; fi
  gh_read issue view "$id" --json "$fields" | jq -r '
    "#\(.number) \(.title)  state=\(.state)  labels=\([.labels[].name] | join(","))  assignee=\('"$gh_who"')",
    "url: \(.url)", "--- description", (.body // "")'
}

tr_statuses() {
  echo "== statuses (labels status:*)"; gh_labels | sed -n 's/^status:/  /p'
  echo "== types (labels type:*)"; gh_labels | sed -n 's/^type:/  /p'
}

tr_list() {
  local what="${1:-board}" label
  shift || true
  case "$what" in
    open) gh_issues --state open --json number,title,labels,assignees | jq -r ".[] | $gh_line" ;;
    ready) gh_issues --state open --label ai:ready --json number,title,labels,assignees | jq -r ".[] | $gh_line" ;;
    status)
      gh_issues --state all --label "status:${1:?forge tracker list status needs the status name}" --json number,title,assignees \
        | jq -r '.[] | "#\(.number) \(.title)  \('"$gh_who"')"' ;;
    json) # the open tickets for triage, in the shape every adapter prints
      gh_issues --state open --json number,title,labels,state,createdAt,updatedAt,author,url \
        | jq '[.[] | {id: .number, title, labels: [.labels[].name], state, createdAt, updatedAt, author: .author.login, url}]' ;;
    board) # one "== <status>" heading per status label, then the open issues carrying that label
      gh_labels | grep '^status:' | while read -r label; do
        echo "== ${label#status:}"
        gh_issues --state open --label "$label" --json number,title,assignees | jq -r '.[] | "  #\(.number) \(.title)  \('"$gh_who"')"'
      done ;;
    *) echo "tracker list: what to list? board, status <name>, open, ready or json" >&2; return 1 ;;
  esac
}

tr_status() {
  local id="${1:?forge tracker status needs a ticket id}" status="${2:?forge tracker status needs the status name}"
  local note label view drop=()
  note="$(tk_note "${@:3}")"
  view="$(gh_read issue view "$id" --json labels,state)" || { echo "tracker: could not read #$id" >&2; return 1; }
  while IFS= read -r label; do
    drop+=(--remove-label "$label")
  done < <(jq -r '.labels[].name | select(startswith("status:"))' <<<"$view")
  gh_write label create "status:$status" --force >/dev/null 2>&1 || true
  gh_write issue edit "$id" ${drop[@]+"${drop[@]}"} --add-label "status:$status" >/dev/null || { echo "tracker: could not set the status of #$id" >&2; return 1; }
  if tk_closes "$status"; then
    # Already closed (a pull request's "Closes #N" on the default branch): only the label changes.
    [[ "$(jq -r .state <<<"$view")" == CLOSED ]] || gh_write issue close "$id" >/dev/null || { echo "tracker: could not close #$id" >&2; return 1; }
  else
    gh_write issue reopen "$id" >/dev/null 2>&1 || true
  fi
  [[ -z "$note" ]] || { gh_write issue comment "$id" --body "$note" >/dev/null && echo "commented"; }
  echo "#$id -> status $status"
}

tr_assign() {
  local id="${1:?forge tracker assign needs a ticket id}" name="${2:?forge tracker assign needs the assignee login}"
  gh_write issue edit "$id" --add-assignee "$name" >/dev/null || { echo "tracker: could not assign #$id to '$name'" >&2; return 1; }
  echo "#$id -> assignee $name"
}

tr_ready() {
  local id="${1:?forge tracker ready needs a ticket id}" note
  note="$(tk_note "${@:2}")"
  gh_write label create ai:ready --force >/dev/null 2>&1 || true
  gh_write issue edit "$id" --add-label ai:ready >/dev/null
  [[ -z "$note" ]] || gh_write issue comment "$id" --body "$note" >/dev/null
  echo "#$id -> ai:ready"
}

tr_comment() {
  local id="${1:?forge tracker comment needs a ticket id}"
  case "${2:-}" in
    --file) gh_write issue comment "$id" --body-file "${3:?forge tracker comment --file needs a file}" >/dev/null ;;
    *) gh_write issue comment "$id" --body "${2:?forge tracker comment needs the text}" >/dev/null ;;
  esac
  echo "commented on #$id"
}

# gh_place <issue url> <board: issues, frontend or a board number> <column>
gh_place() {
  local url="$1" board="$2" column="$3" number project item field option
  case "$board" in
    issues) number="${GH_PROJECT_ISSUES_NUMBER:-${GH_PROJECT_NUMBER:-}}" ;;
    frontend) number="${GH_PROJECT_FRONTEND_NUMBER:-${GH_PROJECT_NUMBER:-}}" ;;
    *) number="$board" ;;
  esac
  if [[ -z "$number" || -z "$GH_PROJECT_OWNER" ]]; then
    echo "tracker(github): to place the card, set GH_PROJECT_OWNER and GH_PROJECT_NUMBER (or GH_PROJECT_ISSUES_NUMBER / GH_PROJECT_FRONTEND_NUMBER)" >&2
    return 1
  fi
  if tk_dry; then echo "DRY RUN: add $url to project $number of $GH_PROJECT_OWNER, Status $column" >&2; return 0; fi
  # gh project <subcommand> on this board, as JSON
  gh_board() { gh project "$1" "$number" --owner "$GH_PROJECT_OWNER" --format json "${@:2}"; }
  project="$(gh_board view | jq -r .id)"
  item="$(gh_board item-add --url "$url" | jq -r .id)"
  read -r field option < <(gh_board field-list | jq -r --arg column "$column" '
    .fields[] | select(.name == "Status")
    | "\(.id) \(first(.options[] | select((.name | ascii_downcase) == ($column | ascii_downcase)) | .id) // "")"')
  if [[ -z "${field:-}" || -z "${option:-}" ]]; then
    echo "card added to project $number, but its Status field has no '$column' option: set the column on the board" >&2
    return 0
  fi
  gh project item-edit --project-id "$project" --id "$item" --field-id "$field" --single-select-option-id "$option" >/dev/null \
    && echo "card placed in '$column' on project $number"
}

tr_create() {
  tk_create_args "$@" || return 1
  local labels=("type:$tk_type" "status:$tk_status") flags=() pair label id url
  for pair in ${tk_extra[@]+"${tk_extra[@]}"}; do labels+=("${pair%% *}:${pair#* }"); done
  for label in "${labels[@]}"; do flags+=(--label "$label"); done
  [[ -z "$tk_assignee" ]] || flags+=(--assignee "$tk_assignee")
  for id in ${tk_relates[@]+"${tk_relates[@]}"}; do printf -v tk_desc '%s\n\nRelates to #%s' "$tk_desc" "$id"; done
  if tk_dry; then
    echo "DRY RUN: gh issue create --title '$tk_subject' ${flags[*]} --body <${#tk_desc} chars>" >&2
    return 0
  fi
  for label in "${labels[@]}"; do gh_write label create "$label" --force >/dev/null 2>&1 || true; done
  url="$(gh_read issue create --title "$tk_subject" --body "$tk_desc" "${flags[@]}")" || return 1
  printf 'created #%s  %s\n' "${url##*/}" "$url"
  if [[ -n "$tk_board" ]]; then gh_place "$url" "$tk_board" "$tk_column"; fi
  return 0
}
