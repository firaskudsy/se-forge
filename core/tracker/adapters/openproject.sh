#!/usr/bin/env bash
# OpenProject, through its REST API v3 (curl + jq). Set project.tracker to "openproject" to use it.
# Settings, from project.json's project.openproject (forge passes them; a variable already set wins):
#   OPENPROJECT_URL           url: e.g. https://openproject.example.com (no trailing slash needed)
#   OPENPROJECT_PROJECT       project: the identifier (from /projects/<identifier>), its numeric id, or the pasted URL
#   OPENPROJECT_BOARDS        boards: "name=id,name=id", the basic boards (/projects/<identifier>/boards/<id>)
#   OPENPROJECT_BOARD         defaultBoard (or board): the board id used when no --board is given
#   OPENPROJECT_READY_STATUS  readyStatus: the status `ready` moves a ticket to and `list ready` reads (default "Todo")
# The API key is never in project.json: openproject-key.sh finds it (environment, macOS Keychain, Linux keyring,
# or a private file) and it goes to curl through a config file descriptor, never in an argument or in output.
# - A ticket is a work package; its status and type are OpenProject's own. Done, Closed and Resolved are
#   ordinary statuses there (OpenProject closes by status), so `status <id> Closed` is enough.
# - OpenProject has no labels: --source/--area/--repo go into a "Labels:" line at the end of the description.
# - A basic board's columns are hand-ordered lists, not statuses. `list board [<name|id|all>]` shows a board's
#   columns; `status` moves the card on every configured board it sits on (op_place); `create --board X --column Y`
#   puts the new card on board X. With no board configured, `list board` groups by status, `status` changes only
#   the status, and --column becomes the status when one with that name exists.
tk_need curl openproject
tk_need jq openproject

for v in OPENPROJECT_URL OPENPROJECT_PROJECT; do
  if [[ -z "${!v:-}" ]]; then echo "tracker(openproject): $v is not set (project.openproject in project.json; see GUIDE.md, Configuration)" >&2; exit 2; fi
done
# shellcheck source=../openproject-key.sh
. "$(dirname "${BASH_SOURCE[0]}")/../openproject-key.sh"
op_find_key || exit 2
op_base="${OPENPROJECT_URL%/}/api/v3"
# Accept a pasted project URL or path as well as the bare identifier.
OPENPROJECT_PROJECT="${OPENPROJECT_PROJECT##*/projects/}"; OPENPROJECT_PROJECT="${OPENPROJECT_PROJECT%%/*}"
op_ready="${OPENPROJECT_READY_STATUS:-Todo}"

# op_boards: "<name>\t<id>" per configured board, the default board included (named "default" when not in the map).
op_boards() {
  local pair pairs=() seen=" "
  IFS=',' read -ra pairs <<<"$(printf '%s' "${OPENPROJECT_BOARDS:-}" | tr -d ' ')"
  for pair in ${pairs[@]+"${pairs[@]}"}; do
    [[ "$pair" == *=* && "${pair#*=}" =~ ^[0-9]+$ && "$seen" != *" ${pair#*=} "* ]] || continue
    seen+="${pair#*=} "; printf '%s\t%s\n' "${pair%%=*}" "${pair#*=}"
  done
  [[ ! "${OPENPROJECT_BOARD:-}" =~ ^[0-9]+$ || "$seen" == *" $OPENPROJECT_BOARD "* ]] || printf 'default\t%s\n' "$OPENPROJECT_BOARD"
}
# op_default_board: OPENPROJECT_BOARD, else the first configured board, else nothing.
op_default_board() {
  if [[ "${OPENPROJECT_BOARD:-}" =~ ^[0-9]+$ ]]; then echo "$OPENPROJECT_BOARD"; else op_boards | head -n 1 | cut -f2; fi
}
# op_board_id [<name|id>]: a number as is, a name through the map, nothing for the default; fails for an unknown name.
op_board_id() {
  local b="${1:-}"
  if [[ -z "$b" ]]; then op_default_board
  elif [[ "$b" =~ ^[0-9]+$ ]]; then echo "$b"
  else op_boards | awk -F'\t' -v n="$b" 'tolower($1) == tolower(n) { print $2; f = 1; exit } END { exit !f }'
  fi
}
# op_board_label <id>: "<name> (<id>)" from the map, or "<id>"
op_board_label() {
  local name; name="$(op_boards | awk -F'\t' -v i="$1" '$2 == i { print $1; exit }')"
  if [[ -n "$name" ]]; then echo "$name ($1)"; else echo "$1"; fi
}

# op_call <METHOD> <path under /api/v3> [json body]
op_call() {
  local method="$1" path="$2" body="${3:-}" out code
  out="$(curl -sS -K <(printf 'user = "apikey:%s"\n' "$OPENPROJECT_API_KEY") -X "$method" \
    -H 'Content-Type: application/json' ${body:+--data-binary "$body"} \
    -w '\n%{http_code}' "$op_base$path")" || { echo "tracker(openproject): $method $path failed to connect" >&2; return 1; }
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  if [[ "$code" != 2* ]]; then
    [[ -z "${op_quiet:-}" ]] || return 1
    echo "tracker(openproject): $method $path -> HTTP $code $(jq -r '.message // empty' <<<"$out" 2>/dev/null)" >&2
    return 1
  fi
  printf '%s' "$out"
}
op_write() {
  if tk_dry; then echo "DRY RUN: $1 $2 ${3:+<${#3} bytes>}" >&2; printf '{}'; return 0; fi
  op_call "$@"
}
op_q() { jq -rn --arg s "$1" '$s | @uri'; }
# op_wps <filters json>: the project's work packages matching the filters
op_wps() {
  op_call GET "/projects/$OPENPROJECT_PROJECT/work_packages?pageSize=500&sortBy=$(op_q '[["id","asc"]]')&filters=$(op_q "$1")" | jq '._embedded.elements'
}
op_open='[{"status":{"operator":"o","values":null}}]'
# op_href <collection> <name>: the href of the status/type with that name (case-insensitive), or nothing
op_href() {
  local list
  case "$1" in
    statuses) list="$(op_call GET /statuses)" ;;
    types) list="$(op_call GET "/projects/$OPENPROJECT_PROJECT/types")" ;;
  esac || return 1
  jq -r --arg n "$2" '._embedded.elements[] | select((.name | ascii_downcase) == ($n | ascii_downcase)) | ._links.self.href' <<<"$list" | head -n 1
}

op_who='(._links.assignee.title // "-")'
op_line='"#\(.id) \(.subject)  [\(._links.status.title)]  \('"$op_who"')"'

tr_get() {
  local id="${1:?forge tracker get needs a ticket id}" wp
  wp="$(op_call GET "/work_packages/$id")" || return 1
  if [[ "${2:-}" == "--json" ]]; then printf '%s\n' "$wp"; return; fi
  jq -r --arg url "${OPENPROJECT_URL%/}" '
    "#\(.id) \(.subject)  status=\(._links.status.title)  type=\(._links.type.title)  assignee=\('"$op_who"')",
    "url: \($url)/work_packages/\(.id)", "--- description", (.description.raw // "")' <<<"$wp"
}

tr_statuses() {
  echo "== statuses"; op_call GET /statuses | jq -r '._embedded.elements[] | "  \(.name)\(if .isClosed then "  (closed)" else "" end)"'
  echo "== types"; op_call GET "/projects/$OPENPROJECT_PROJECT/types" | jq -r '._embedded.elements[] | "  \(.name)"'
}

# op_status_filter <status name>: a filter on that status, or fails when there is none
op_status_filter() {
  local href; href="$(op_href statuses "$1")"
  [[ -n "$href" ]] || { echo "tracker(openproject): no status named '$1' (forge tracker statuses lists them)" >&2; return 1; }
  jq -cn --arg id "${href##*/}" '[{"status":{"operator":"=","values":[$id]}}]'
}

op_by_status() {
  op_wps "$op_open" | jq -r 'group_by(._links.status.title)[] |
    "== \(.[0]._links.status.title)", (.[] | "  #\(.id) \(.subject)  \('"$op_who"')")'
}

# op_show_board <board id>: each column of the board with its cards
op_show_board() {
  local cols q name
  cols="$(op_columns "$1")" || return 1
  while IFS=$'\t' read -r q name; do
    [[ -n "$q" ]] || continue
    echo "== $name"
    op_call GET "/queries/$q?pageSize=500" | jq -r '._embedded.results._embedded.elements[]? |
      "  #\(.id) \(.subject)  [\(._links.status.title)]  \('"$op_who"')"'
  done <<<"$cols"
}

tr_list() {
  local what="${1:-board}" f
  shift || true
  case "$what" in
    open) op_wps "$op_open" | jq -r ".[] | $op_line" ;;
    ready) f="$(op_status_filter "$op_ready")" || return 1; op_wps "$f" | jq -r ".[] | $op_line" ;;
    status) f="$(op_status_filter "${1:?forge tracker list status needs the status name}")" || return 1
      op_wps "$f" | jq -r ".[] | $op_line" ;;
    json) op_wps "$op_open" | jq --arg url "${OPENPROJECT_URL%/}" '[.[] | {id, title: .subject,
        labels: [("type::" + ._links.type.title), ("status::" + ._links.status.title)], state: "opened",
        createdAt, updatedAt, author: ._links.author.title, url: "\($url)/work_packages/\(.id)"}]' ;;
    board) local board boards name id
      boards="$(op_boards)"
      if [[ "${1:-}" == all ]]; then
        if [[ -z "$boards" ]]; then echo "no boards configured (project.openproject.boards): open work packages by status"; op_by_status; return; fi
        while IFS=$'\t' read -r name id; do
          echo "### $name ($id)"
          op_show_board "$id" || true
        done <<<"$boards"
        return 0
      fi
      if [[ -n "${1:-}" ]] && ! board="$(op_board_id "$1")"; then
        echo "tracker(openproject): no board named '$1' in project.openproject.boards${boards:+ (configured: $(cut -f1 <<<"$boards" | paste -sd, -))}" >&2
        return 1
      fi
      [[ -n "${1:-}" ]] || board="$(op_default_board)"
      if [[ -z "$board" ]]; then op_by_status; return; fi
      op_show_board "$board" ;;
    *) echo "tracker list: what to list? board [<name|id|all>], status <name>, open, ready or json" >&2; return 1 ;;
  esac
}

# op_columns <board id>: "<query id>\t<column name>" per column, left to right. A board OpenProject does not
# have (or the key cannot see) is named in one line and fails.
op_columns() {
  local grid q
  grid="$(op_quiet=1 op_call GET "/grids/$1")" || {
    echo "board $(op_board_label "$1"): not found on OpenProject (or this API key cannot see it); skipped" >&2; return 1; }
  jq -r '.widgets | sort_by(.startColumn)[] | .options.queryId // empty' <<<"$grid" | while read -r q; do
    printf '%s\t%s\n' "$q" "$(op_call GET "/queries/$q?pageSize=0" | jq -r .name)"
  done
}

# op_column <status>: the column a status maps to when no column has the status's own name. Nothing for Todo,
# Ready for Development and any status not listed, so the card stays where it is.
op_column() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    "in development"|"code review") echo "In Process" ;;
    "in testing"|"ready for qa"|"in qa") echo "In Testing" ;;
    "ready for release") echo "To Be Deployed" ;;
    done|closed|resolved) echo "Complete" ;;
    rejected) echo "Canceled" ;;
    "on hold"|blocked|pending) echo "Pending" ;;
  esac
}

# op_place <wp id> <board id> <status|column> <mode>: move the card to its column on that board, taking it out of
# every other column. mode "status": the column named like the status wins, else op_column's; the card must
# already be on the board. mode "column": the column of that name; the card is added.
# Returns 0 when done (or left in place), 3 when the card is not on the board, 4 when the board cannot be read.
op_place() {
  local id="$1" board="$2" want="$3" mode="$4" label cols target tname q name order sits="" max=-1
  label="$(op_board_label "$board")"
  cols="$(op_columns "$board")" || return 4
  tname="$want"
  target="$(awk -F'\t' -v c="$tname" 'tolower($2) == tolower(c) { print $1; exit }' <<<"$cols")"
  if [[ -z "$target" && "$mode" == status ]]; then
    tname="$(op_column "$want")"
    [[ -z "$tname" ]] || target="$(awk -F'\t' -v c="$tname" 'tolower($2) == tolower(c) { print $1; exit }' <<<"$cols")"
  fi
  while IFS=$'\t' read -r q name; do
    [[ -n "$q" ]] || continue
    order="$(op_call GET "/queries/$q/order")" || return 4
    jq -e --arg id "$id" 'has($id)' <<<"$order" >/dev/null && sits+="$q "
    [[ "$q" != "$target" ]] || max="$(jq '[.[]] | max // -1' <<<"$order")"
  done <<<"$cols"
  [[ "$mode" != status || -n "$sits" ]] || return 3
  if [[ -z "$tname" ]]; then echo "card left where it is on board $label"; return 0; fi
  if [[ -z "$target" ]]; then echo "card not moved on board $label: no column named '$tname'" >&2; return 0; fi
  for q in $sits; do
    [[ "$q" == "$target" ]] || op_write PATCH "/queries/$q/order" "$(jq -cn --arg id "$id" '{delta: {($id): -1}}')" >/dev/null || return 4
  done
  if [[ " $sits" == *" $target "* ]]; then echo "card already in '$tname' on board $label"; return 0; fi
  op_write PATCH "/queries/$target/order" "$(jq -cn --arg id "$id" --argjson p "$((max + 1))" '{delta: {($id): $p}}')" >/dev/null || return 4
  echo "card moved to '$tname' on board $label"
}

# op_follow <wp id> <status>: move the card on every configured board where it sits. Nothing without boards.
op_follow() {
  local id="$1" status="$2" boards name bid rc found=0 absent=""
  boards="$(op_boards)"
  [[ -n "$boards" ]] || return 0
  while IFS=$'\t' read -r name bid; do
    op_place "$id" "$bid" "$status" status; rc=$?
    case "$rc" in
      0) found=1 ;;
      3) absent+="${absent:+, }$name ($bid)" ;;
      4) ;;
      *) echo "card not moved on board $name ($bid)" >&2 ;;
    esac
  done <<<"$boards"
  [[ "$found" == 1 || -z "$absent" ]] || echo "card #$id is on none of the boards ($absent): not moved"
  return 0
}

op_comment() {
  op_write POST "/work_packages/$1/activities" "$(jq -cn --arg t "$2" '{comment: {raw: $t}}')" >/dev/null
}

# op_set_status <id> <status name>
op_set_status() {
  local id="$1" href lock
  href="$(op_href statuses "$2")"
  [[ -n "$href" ]] || { echo "tracker(openproject): no status named '$2' (forge tracker statuses lists them)" >&2; return 1; }
  lock="$(op_call GET "/work_packages/$id" | jq -r .lockVersion)" || return 1
  op_write PATCH "/work_packages/$id" "$(jq -cn --argjson l "$lock" --arg h "$href" '{lockVersion: $l, _links: {status: {href: $h}}}')" >/dev/null
}

tr_status() {
  local id="${1:?forge tracker status needs a ticket id}" status="${2:?forge tracker status needs the status name}" note
  note="$(tk_note "${@:3}")"
  op_set_status "$id" "$status" || { echo "tracker: could not set the status of #$id" >&2; return 1; }
  [[ -z "$note" ]] || { op_comment "$id" "$note" && echo "commented"; }
  echo "#$id -> status $status"
  op_follow "$id" "$status"
}

tr_ready() {
  local id="${1:?forge tracker ready needs a ticket id}" note
  note="$(tk_note "${@:2}")"
  op_set_status "$id" "$op_ready" || return 1
  [[ -z "$note" ]] || op_comment "$id" "$note"
  echo "#$id -> $op_ready"
}

tr_comment() {
  local id="${1:?forge tracker comment needs a ticket id}" text
  case "${2:-}" in
    --file) text="$(<"${3:?forge tracker comment --file needs a file}")" ;;
    *) text="${2:?forge tracker comment needs the text}" ;;
  esac
  op_comment "$id" "$text" || return 1
  echo "commented on #$id"
}

tr_create() {
  tk_create_args "$@" || return 1
  local type_href status_href desc body created id rel status="$tk_status" pair labels=()
  for pair in ${tk_extra[@]+"${tk_extra[@]}"}; do labels+=("${pair%% *}::${pair#* }"); done
  desc="$tk_desc"
  [[ ${#labels[@]} -eq 0 ]] || desc+=$'\n\n'"Labels: ${labels[*]}"
  local bid="" unplaced=""
  if [[ -n "$tk_board" ]]; then
    if bid="$(op_board_id "$tk_board")" && [[ -n "$bid" ]]; then :
    elif [[ -z "$(op_boards)" ]]; then bid=""; unplaced="card not placed: no OpenProject board configured (project.openproject.boards)"
    else bid=""; unplaced="card not placed: no board named '$tk_board' in project.openproject.boards"
    fi
  fi
  # Without a board, a column is read as a status.
  [[ -n "$bid" || -z "$tk_board" || -z "$(op_href statuses "$tk_column")" ]] || status="$tk_column"
  type_href="$(op_href types "$tk_type")"
  [[ -n "$type_href" ]] || { echo "tracker(openproject): the project has no type named '$tk_type'" >&2; return 1; }
  status_href="$(op_href statuses "$status")"
  body="$(jq -cn --arg s "$tk_subject" --arg d "$desc" --arg t "$type_href" \
    '{subject: $s, description: {format: "markdown", raw: $d}, _links: {type: {href: $t}}}')"
  if tk_dry; then
    echo "DRY RUN: POST /projects/$OPENPROJECT_PROJECT/work_packages subject='$tk_subject' type=$tk_type status=$status relates=${tk_relates[*]-} <${#desc} chars>" >&2
    if [[ -n "$bid" ]]; then echo "DRY RUN: place the card in '$tk_column' on board $(op_board_label "$bid")" >&2
    elif [[ -n "$unplaced" ]]; then echo "$unplaced" >&2; fi
    return 0
  fi
  created="$(op_call POST "/projects/$OPENPROJECT_PROJECT/work_packages" "$body")" || return 1
  id="$(jq -r .id <<<"$created")"
  printf 'created #%s  %s/work_packages/%s\n' "$id" "${OPENPROJECT_URL%/}" "$id"
  if [[ -n "$status_href" && "$(jq -r ._links.status.href <<<"$created")" != "$status_href" ]]; then
    op_set_status "$id" "$status" || echo "status '$status' not set; the work package keeps its initial status" >&2
  fi
  for rel in ${tk_relates[@]+"${tk_relates[@]}"}; do
    op_call POST "/work_packages/$id/relations" \
      "$(jq -cn --arg to "/api/v3/work_packages/$rel" '{type: "relates", _links: {to: {href: $to}}}')" >/dev/null \
      && echo "relates to #$rel" || echo "relation to #$rel not created" >&2
  done
  if [[ -n "$bid" ]]; then op_place "$id" "$bid" "$tk_column" column || [[ $? == 4 ]] || echo "card not placed in '$tk_column'" >&2
  elif [[ -n "$unplaced" ]]; then echo "$unplaced" >&2; fi
  return 0
}
