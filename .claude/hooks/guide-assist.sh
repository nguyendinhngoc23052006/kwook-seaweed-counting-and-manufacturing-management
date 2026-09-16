#!/usr/bin/env bash
# guide-assist.sh — the app repo's rule injector (UserPromptSubmit hook).
#
# Copied from the guide's templates/hooks/. No placeholders.
#
# The constitution (CLAUDE.md) is in context, but a long session buries it and
# compaction can drop it. This hook re-injects the governing rule at the moment
# of the decision it governs, keyed on words in the prompt. Never blocks
# (exit 0 always); only adds context. Every rule below restates a rule that
# already exists in this repo's CLAUDE.md — if they disagree, CLAUDE.md wins
# and this file needs a /refresh from the guide.

set -u

# Only meaningful in a repo that has a constitution to restate.
[ -f "CLAUDE.md" ] || exit 0

payload=$(cat)
prompt=$(printf '%s' "$payload" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null || echo "")

[ -z "$prompt" ] && exit 0

lc=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')

msgs=""
add() { msgs="${msgs}${msgs:+ | }$1"; }

# --- migrations ------------------------------------------------------------
case "$lc" in
  *migration*|*schema*|*"db push"*|*"sql editor"*|*"create table"*|*postgres*)
    add "Migrations are the source of truth; merging IS applying — never hand-apply through a dashboard SQL editor. Every create table ships RLS AND its grants in the same migration (RLS filters on top of a grant, it never supplies one). New DDL must be re-runnable." ;;
esac

# --- RLS / policies --------------------------------------------------------
case "$lc" in
  *" rls"*|*policy*|*policies*|*"row level"*)
    add "Deny by default: a user touches only their own rows; grants ride beside policies, only the roles that touch the table, only the verbs they need. service_role bypasses RLS but NOT grants." ;;
esac

# --- PR gate ---------------------------------------------------------------
case "$lc" in
  *"pull request"*|*"open a pr"*|*"open pr"*|*"one pr"*|*"1 pr"*)
    add "One PR into the target branch named in CLAUDE.md's Scope, and stop there — never merge or deploy. Write .claude/pr-body.md FIRST with the fully-ticked Self-check; dispatch the three reviewers (each one model tier BELOW yours, model: passed explicitly) and refresh .claude/review/* before opening." ;;
esac

# --- deploy / production ---------------------------------------------------
case "$lc" in
  *deploy*|*"go live"*|*production*|*rollout*)
    add "You never merge or deploy — the human does, from a reviewed PR. Irreversible actions need a preview guard + idempotency + a manual-verify flag in the PR." ;;
esac

# --- secrets ---------------------------------------------------------------
case "$lc" in
  *secret*|*credential*|*"api key"*|*"service role"*|*service_role*|*token*|*.env*)
    add "Two keys, two worlds: publishable key in the browser, secret key only in secret stores and Deno.env — never in code, logs, or PR text. A secret that ever touches a commit is ROTATED, not deleted." ;;
esac

# --- recovery --------------------------------------------------------------
case "$lc" in
  *"merge conflict"*|*"resolve conflict"*|*rebase*|*broke*|*broken*|*rollback*|*revert*)
    add "A dashboard rollback repoints traffic but does NOT touch the branch — pair it with a revert PR or the next push overwrites it. Never force-push a shared branch; treat obstacles as root causes, never --no-verify." ;;
esac

# --- dependencies ----------------------------------------------------------
case "$lc" in
  *dependency*|*dependencies*|*"npm install"*|*"add a package"*|*"new package"*|*library*)
    add "No new dependency unless the task names one or it removes meaningful code — every dependency is attack surface. Dependabot owns versions; commit the lockfile; no unpinned latest." ;;
esac

# --- platform claims -------------------------------------------------------
case "$lc" in
  *"official docs"*|*"platform docs"*|*"is it still"*|*"current version"*|*deprecat*)
    add "Never answer a platform question from memory — read the current official docs first." ;;
esac

# --- constitution ----------------------------------------------------------
case "$lc" in
  *claude.md*|*constitution*|*rulebook*|*"the rules"*)
    add "CLAUDE.md is the read-only constitution, GENERATED from the guide — propose rule changes to the human, never self-edit; regenerate via /refresh, never edit the copy to disagree with its source." ;;
esac

[ -z "$msgs" ] && exit 0

MSG="[guide-assist] $msgs" python3 -c "
import json, os
print(json.dumps({
  'hookSpecificOutput': {
    'hookEventName': 'UserPromptSubmit',
    'additionalContext': os.environ['MSG']
  }
}))
"
exit 0
