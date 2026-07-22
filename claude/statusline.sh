#!/usr/bin/env bash
input=$(cat)

RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"
FG_GRAY="\033[37m"
FG_CYAN="\033[36m"
FG_YELLOW="\033[33m"
FG_GREEN="\033[32m"
FG_RED="\033[31m"
FG_MAGENTA="\033[35m"
FG_BLUE="\033[34m"
FG_ORANGE="\033[38;5;208m"

# Format integer as compact k-suffix string
fmt_k() {
  awk -v n="${1:-0}" 'BEGIN {
    if (n >= 1000) {
      k = n / 1000
      if (k >= 100) printf "%dk", int(k + 0.5)
      else if (k >= 10) printf "%.0fk", k
      else printf "%.1fk", k
    } else { printf "%d", n }
  }'
}

# Compact countdown: ->3d1h, ->1h2m, ->45m
countdown() {
  local reset_at="$1"
  local now secs days hours mins
  now=$(date +%s)
  secs=$(( reset_at - now ))
  [ "$secs" -le 0 ] && return
  days=$(( secs / 86400 ))
  hours=$(( (secs % 86400) / 3600 ))
  mins=$(( (secs % 3600) / 60 ))
  if [ "$days" -gt 0 ]; then
    echo -n "->${days}d${hours}h"
  elif [ "$hours" -gt 0 ]; then
    echo -n "->${hours}h${mins}m"
  else
    echo -n "->${mins}m"
  fi
}

# --- Extract fields ---
model=$(echo "$input" | jq -r '.model.display_name // ""')
model_id=$(echo "$input" | jq -r '.model.id // ""')
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
effort=$(echo "$input" | jq -r '.effort.level // ""')
thinking=$(echo "$input" | jq -r '.thinking.enabled // false')
output_style=$(echo "$input" | jq -r '.output_style.name // ""')
cost_usd=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
ctx_pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // 0')
total_input=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
total_output=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
five_used=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_resets_at=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
seven_used=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
seven_resets_at=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')

# --- Line 1: /path/to/cwd (branch) [flags] ---
dir_display="$cwd"
[ -n "$HOME" ] && dir_display=$(echo "$cwd" | sed "s|^$HOME|~|")

line1="${BOLD}${FG_GREEN}${dir_display}${RESET}"

if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
    flags=""
    gs=$(git -C "$cwd" status --porcelain 2>/dev/null)
    echo "$gs" | grep -q "^[MADRC]" && flags+="+"
    echo "$gs" | grep -q "^.[MD]"   && flags+="!"
    echo "$gs" | grep -q "^??"      && flags+="?"
    flag_str=""
    [ -n "$flags" ] && flag_str=" ${FG_YELLOW}[${flags}]${RESET}"
    line1+=" ${FG_YELLOW}(${branch})${RESET}${flag_str}"
  fi
fi

# --- Pre-compute token/cost/ctx values ---
up_k=$(fmt_k "$total_input")
dn_k=$(fmt_k "$total_output")
rd_k=$(fmt_k "$cache_read")
cost_str=$(awk -v c="$cost_usd" 'BEGIN { printf "$%.3f", c }')

ctx_p_int=$(printf "%.0f" "$ctx_pct")
ctx_k=$(fmt_k "$ctx_size")
if   [ "$ctx_p_int" -ge 80 ]; then ctx_color="$FG_RED"
elif [ "$ctx_p_int" -ge 50 ]; then ctx_color="$FG_YELLOW"
else ctx_color="$FG_GRAY"; fi

# Pre-compute rate limit values
five_pct="" five_cd=""
if [ -n "$five_used" ]; then
  five_pct=$(printf "%.0f" "$five_used")
  [ -n "$five_resets_at" ] && five_cd=$(countdown "$five_resets_at")
  if   [ "$five_pct" -ge 80 ]; then five_color="$FG_RED"
  elif [ "$five_pct" -ge 50 ]; then five_color="$FG_YELLOW"
  else five_color="$FG_GREEN"; fi
fi

seven_pct="" seven_cd=""
if [ -n "$seven_used" ]; then
  seven_pct=$(printf "%.0f" "$seven_used")
  [ -n "$seven_resets_at" ] && seven_cd=$(countdown "$seven_resets_at")
  if   [ "$seven_pct" -ge 80 ]; then seven_color="$FG_RED"
  elif [ "$seven_pct" -ge 50 ]; then seven_color="$FG_YELLOW"
  else seven_color="$FG_GREEN"; fi
fi

# Output style tag
style_tag=""
if [ -n "$output_style" ] && [ "$output_style" != "default" ]; then
  style_tag="$output_style"
fi

# --- agentharness-comms reference: <name>@<project> ---
# Mirrors what the pi side shows for itself (e.g. agent-YV2F0H@blah).
#
# The name is assigned at listener startup and changes on every container
# rebuild, so it must be read live rather than baked in. The registry entry
# has no `project` field — project is implicit in the path
# (<COMS_DIR>/projects/<project>/agents/<name>.json) — so we take the name
# from the file and the project from its directory.
#
# We find OUR entry by matching container_id against the hostname, which is
# how the adapters identify themselves. Empty (section omitted) if the
# listener isn't running or the coms dir isn't mounted.
coms_ref=""
_coms_dir="${COMS_DIR:-$HOME/.agentharness-comms}"
_me="${CONTAINER_ID:-$(hostname)}"
if [ -d "$_coms_dir/projects" ]; then
  # Single jq pass over all entries; input_filename gives us the path back.
  _hit=$(jq -r --arg me "$_me" \
    'select(.container_id == $me) | "\(input_filename)\t\(.name)"' \
    "$_coms_dir"/projects/*/agents/*.json 2>/dev/null | head -1)
  if [ -n "$_hit" ]; then
    _f=${_hit%%$'\t'*}
    _nm=${_hit##*$'\t'}
    _proj=$(basename "$(dirname "$(dirname "$_f")")")
    [ -n "$_nm" ] && coms_ref="${_nm}@${_proj}"
  fi
fi

# --- Publish the resolved model id for the coms registry ---
# identity.ts's resolveModel() has no reliable way to learn this itself: no
# hook but SessionStart ever receives a `model` field, there's no
# $CLAUDE_MODEL env var, and ~/.claude/settings.json's "model" key holds
# whatever the user typed at the /model prompt — often a bare alias like
# "sonnet", not the resolved id. That produced "anthropic/sonnet" in the
# coms peer list instead of "anthropic/claude-sonnet-5".
#
# This status line already receives the resolved id on every invocation
# (model.id, e.g. "claude-opus-4-8") — the same field pi reads from its
# in-process context. We just have to hand it to the listener/MCP server,
# which run in separate processes and never see this JSON. A small file is
# the only channel they share. Refreshed here every ~5s (refreshInterval)
# and on every message, so a live /model change reaches coms within one
# tick — no restart required, unlike a SessionStart-only hook.
#
# Written only when coms is active (coms_ref non-empty), matching the
# convention everywhere else in this script; harmless but pointless
# otherwise, since nothing would read it.
if [ -n "$coms_ref" ] && [ -n "$model_id" ]; then
  _model_dir="$_coms_dir/sessions/$_me"
  mkdir -p "$_model_dir" 2>/dev/null && \
    printf '%s' "$model_id" > "$_model_dir/resolved_model.txt.tmp" 2>/dev/null && \
    mv "$_model_dir/resolved_model.txt.tmp" "$_model_dir/resolved_model.txt" 2>/dev/null
fi

# --- Line 2 left: ↑tok ↓tok Rcache $cost ctx%/size  5h X%->t  󱄵 7d X%->t ---
left_colored="${FG_CYAN}↑${up_k}${RESET} ${FG_BLUE}↓${dn_k}${RESET} ${DIM}${FG_GRAY}R${rd_k}${RESET}"
left_colored+=" ${FG_GREEN}${cost_str}${RESET}"
left_colored+="  ${ctx_color}${ctx_p_int}%${RESET}${DIM}${FG_GRAY}/${ctx_k}${RESET}"


if [ -n "$five_pct" ]; then
  left_colored+="   ${DIM}${FG_GRAY}5h${RESET} ${five_color}${five_pct}%${RESET}"
  if [ -n "$five_cd" ]; then
    left_colored+="${DIM}${FG_GRAY}${five_cd}${RESET}"
  fi
fi

if [ -n "$seven_pct" ]; then
  left_colored+="  󱄵 ${DIM}${FG_GRAY}7d${RESET} ${seven_color}${seven_pct}%${RESET}"
  if [ -n "$seven_cd" ]; then
    left_colored+="${DIM}${FG_GRAY}${seven_cd}${RESET}"
  fi
fi

[ -n "$style_tag" ] && { left_colored+=" ${DIM}${FG_GRAY}(${style_tag})${RESET}"; left_plain+=" (${style_tag})"; }

# Coms identity, pipe-separated, after the usage figures.
if [ -n "$coms_ref" ]; then
  left_colored+="  ${DIM}${FG_GRAY}|${RESET} ${FG_MAGENTA}${coms_ref}${RESET}"
fi

# --- Append model • effort [~thinking] to line 1 ---
case "$effort" in
  low)    eff_color="$FG_GRAY" ;;
  medium) eff_color="$FG_YELLOW" ;;
  high)   eff_color="$FG_ORANGE" ;;
  xhigh)  eff_color="$FG_RED" ;;
  max)    eff_color="${BOLD}${FG_RED}" ;;
  *)      eff_color="$FG_GRAY" ;;
esac

[ -n "$model" ] && line1+="  |  ${BOLD}${FG_CYAN}${model}${RESET}"
if [ -n "$effort" ]; then
  line1+=" ${DIM}${FG_GRAY}•${RESET} ${eff_color}${effort}${RESET}"
fi
if [ "$thinking" = "true" ]; then
  line1+=" ${FG_MAGENTA}~thinking${RESET}"
fi

# --- Coms peer pool box, above everything else ---
# Gated on $coms_ref, which is non-empty only when our own listener is
# registered — so no node process is spawned at all when coms is inactive.
# The renderer is compiled into the image, so it may not exist yet on a
# container built before this feature: stderr is discarded and empty output
# is a no-op, keeping the status line at its normal two rows either way.
if [ -n "$coms_ref" ]; then
  _coms_bin="${AGENTHARNESS_COMMS_BIN:-/claude/coms-mcp-server/dist/claude/coms-mcp-server/src/cli.js}"
  # `grep -q pool` first: a binary built before this feature falls through its
  # dispatch to the MCP server, which would spin up a stdio server on every
  # refresh tick (~400ms wasted) instead of printing rows. Checking is far
  # cheaper than spawning it. `< /dev/null` and `timeout` are belt-and-braces
  # so the status line can never block on a process waiting for input.
  if [ -f "$_coms_bin" ] && grep -q '"pool"' "$_coms_bin" 2>/dev/null; then
    pool_out=$(COLUMNS="${COLUMNS:-}" timeout 2 node "$_coms_bin" pool < /dev/null 2>/dev/null)
    [ -n "$pool_out" ] && printf "%s\n" "$pool_out"
  fi
fi

printf "%b\n" "$line1"
printf "%b\n" "$left_colored"
