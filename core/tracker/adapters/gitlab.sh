#!/usr/bin/env bash
# GitLab, through the glab CLI.
# - A ticket is an issue. Its status is its single `status::<Name>` label and its type a `type::<Name>` label.
#   On GitLab Premium those are scoped labels; on Free they are plain ones, so this adapter removes the old
#   status label itself. Done, Closed and Resolved close the issue. A related ticket becomes an issue link.
# - A board column is a label list: --board/--column give the issue the label of the list with that name.
# glab signs in by itself (GITLAB_TOKEN or `glab auth login`) and reads GITLAB_HOST for a self-managed
# server. GITLAB_REPO (group/project) is needed only when glab cannot tell it from the git remote.
# Nothing here prints a credential.
tk_need glab gitlab 'brew install glab; glab auth login'
tk_need jq gitlab

gl_repo=()
[[ -z "${GITLAB_REPO:-}" ]] || gl_repo=(--repo "$GITLAB_REPO")
gl_read() { glab "$@" ${gl_repo[@]+"${gl_repo[@]}"}; }
gl_write() {
  if tk_dry; then echo "DRY RUN: glab $*" >&2; return 0; fi
  gl_read "$@"
}
gl_issues() { gl_read issue list "$@" --output json --per-page 100; }
gl_labels() { gl_read label list --output json --per-page 100 | jq -r '.[].name'; }
# gl_label <name>: create the label the first time the project needs it.
gl_label() { gl_labels | grep -qxF "$1" || gl_write label create --name "$1" >/dev/null 2>&1 || true; }

# jq pieces: the assignees ("-" for none), and a ticket line with its status.
gl_who='([.assignees[]?.username] | if length == 0 then "-" else join(",") end)'
gl_line='"#\(.iid) \(.title)  [\([.labels[] | select(startswith("status::")) | .[8:]] | join(","))]  \('"$gl_who"')"'

tr_get() {
  local id="${1:?forge tracker get needs a ticket id}"
  if [[ "${2:-}" == "--json" ]]; then gl_read issue view "$id" --output json; return; fi
  gl_read issue view "$id" --output json | jq -r '
    "#\(.iid) \(.title)  state=\(.state)  labels=\(.labels | join(","))  assignee=\('"$gl_who"')",
    "url: \(.web_url)", "--- description", (.description // "")'
}

tr_statuses() {
  echo "== statuses (labels status::*)"; gl_labels | sed -n 's/^status::/  /p'
  echo "== types (labels type::*)"; gl_labels | sed -n 's/^type::/  /p'
}

tr_list() {
  local what="${1:-board}" label
  shift || true
  case "$what" in
    open) gl_issues | jq -r ".[] | $gl_line" ;;
    ready) gl_issues --label ai::ready | jq -r ".[] | $gl_line" ;;
    status) gl_issues --all --label "status::${1:?forge tracker list status needs the status name}" | jq -r ".[] | $gl_line" ;;
    json) # the open tickets for triage, in the shape every adapter prints
      gl_issues | jq '[.[] | {id: .iid, title, labels, state, createdAt: .created_at, updatedAt: .updated_at, author: .author.username, url: .web_url}]' ;;
    board) # one "== <status>" heading per status label, then the open issues carrying that label
      gl_labels | grep '^status::' | while read -r label; do
        echo "== ${label#status::}"
        gl_issues --label "$label" | jq -r '.[] | "  #\(.iid) \(.title)  \('"$gl_who"')"'
      done ;;
    *) echo "tracker list: what to list? board, status <name>, open, ready or json" >&2; return 1 ;;
  esac
}

tr_status() {
  local id="${1:?forge tracker status needs a ticket id}" status="${2:?forge tracker status needs the status name}"
  local note label view drop=()
  note="$(tk_note "${@:3}")"
  view="$(gl_read issue view "$id" --output json)" || { echo "tracker: could not read #$id" >&2; return 1; }
  while IFS= read -r label; do
    drop+=(--unlabel "$label")
  done < <(jq -r '.labels[] | select(startswith("status::"))' <<<"$view")
  gl_label "status::$status"
  gl_write issue update "$id" ${drop[@]+"${drop[@]}"} --label "status::$status" >/dev/null || { echo "tracker: could not set the status of #$id" >&2; return 1; }
  if tk_closes "$status"; then
    # Already closed (a merge request's "Closes #N" on the default branch): only the label changes.
    [[ "$(jq -r .state <<<"$view")" == closed ]] || gl_write issue close "$id" >/dev/null || { echo "tracker: could not close #$id" >&2; return 1; }
  else
    gl_write issue reopen "$id" >/dev/null 2>&1 || true
  fi
  [[ -z "$note" ]] || { gl_write issue note "$id" --message "$note" >/dev/null && echo "commented"; }
  echo "#$id -> status $status"
}

tr_assign() {
  local id="${1:?forge tracker assign needs a ticket id}" name="${2:?forge tracker assign needs the assignee username}"
  gl_write issue update "$id" --assignee "$name" >/dev/null || { echo "tracker: could not assign #$id to '$name'" >&2; return 1; }
  echo "#$id -> assignee $name"
}

tr_ready() {
  local id="${1:?forge tracker ready needs a ticket id}" note
  note="$(tk_note "${@:2}")"
  gl_label ai::ready
  gl_write issue update "$id" --label ai::ready >/dev/null
  [[ -z "$note" ]] || gl_write issue note "$id" --message "$note" >/dev/null
  echo "#$id -> ai::ready"
}

tr_comment() {
  local id="${1:?forge tracker comment needs a ticket id}"
  case "${2:-}" in
    --file) gl_write issue note "$id" --message "$(<"${3:?forge tracker comment --file needs a file}")" >/dev/null ;;
    *) gl_write issue note "$id" --message "${2:?forge tracker comment needs the text}" >/dev/null ;;
  esac
  echo "commented on #$id"
}

# gl_place <issue iid> <board: its name (issues, frontend, …) or id> <column>
gl_place() {
  local iid="$1" board="$2" column="$3" label
  label="$(gl_read api 'projects/:id/boards' | jq -r --arg board "$board" --arg column "$column" '
    map(select($board == "" or ((.name // "") | ascii_downcase) == ($board | ascii_downcase) or (.id | tostring) == $board))
    | [.[].lists[]? | .label.name // empty | select(ascii_downcase == ($column | ascii_downcase))]
    | first // empty')"
  if [[ -z "$label" ]]; then
    echo "card not placed: board '$board' has no list named '$column' (a list is a label; add the list in GitLab)" >&2
    return 0
  fi
  gl_write issue update "$iid" --label "$label" >/dev/null && echo "card placed in '$column' (label $label)"
}

tr_create() {
  tk_create_args "$@" || return 1
  local labels=("type::$tk_type" "status::$tk_status") links=() pair label id joined url
  for pair in ${tk_extra[@]+"${tk_extra[@]}"}; do labels+=("${pair%% *}::${pair#* }"); done
  for id in ${tk_relates[@]+"${tk_relates[@]}"}; do links+=(--linked-issues "$id"); done
  [[ ${#links[@]} -eq 0 ]] || links+=(--link-type relates_to)
  [[ -z "$tk_assignee" ]] || links+=(--assignee "$tk_assignee")
  joined="$(IFS=,; echo "${labels[*]}")"
  if tk_dry; then
    echo "DRY RUN: glab issue create --title '$tk_subject' --label $joined ${links[*]+${links[*]}} --description <${#tk_desc} chars> --yes" >&2
    [[ -z "$tk_board" ]] || echo "DRY RUN: place the card in '$tk_column' on board '$tk_board'" >&2
    return 0
  fi
  for label in "${labels[@]}"; do gl_label "$label"; done
  url="$(gl_read issue create --title "$tk_subject" --description "$tk_desc" --label "$joined" ${links[@]+"${links[@]}"} --yes \
    | grep -Eo 'https?://[^ ]+/-/(issues|work_items)/[0-9]+' | tail -n 1)" || return 1
  [[ -n "$url" ]] || { echo "tracker(gitlab): glab printed no issue URL" >&2; return 1; }
  printf 'created #%s  %s\n' "${url##*/}" "$url"
  if [[ -n "$tk_board" ]]; then gl_place "${url##*/}" "$tk_board" "$tk_column"; fi
  return 0
}
