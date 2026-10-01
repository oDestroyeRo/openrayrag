# Issue tracker: GitHub

Issues and specs live in [oDestroyeRo/openrayrag](https://github.com/oDestroyeRo/openrayrag/issues). Use the `gh` CLI.

## Repository selection

Pass `--repo oDestroyeRo/openrayrag` to every `gh issue` or `gh pr` command. For REST calls, use `gh api --hostname github.com repos/oDestroyeRo/openrayrag/...`.

## Conventions

- Create: `gh issue create --repo oDestroyeRo/openrayrag --title "<title>" --body-file <body-file>`.
- Read, including labels and conversation: `gh issue view <number> --repo oDestroyeRo/openrayrag --json number,title,body,labels,comments,state,url`.
- List: `gh issue list --repo oDestroyeRo/openrayrag --state open --json number,title,body,labels,comments`; add label or state filters as needed.
- Comment: `gh issue comment <number> --repo oDestroyeRo/openrayrag --body-file <body-file>`.
- Apply or remove labels: `gh issue edit <number> --repo oDestroyeRo/openrayrag --add-label "<label>"` or `--remove-label "<label>"`. Use the mapping in `triage-labels.md`.
- Close: `gh issue close <number> --repo oDestroyeRo/openrayrag`.

Write multiline issue bodies and comments to a temporary UTF-8 file and pass it with `--body-file`.

GitHub issues and pull requests share a number space. Resolve a bare `#<number>` with `gh pr view <number> --repo oDestroyeRo/openrayrag`, falling back to `gh issue view <number> --repo oDestroyeRo/openrayrag`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill terminology

- "Publish to the issue tracker": create a GitHub issue.
- "Fetch the relevant ticket": read the issue, its labels, and its comments.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets. All commands use the repository selection above.

- Map: an issue labelled `wayfinder:map`, holding Notes / Decisions-so-far / Fog.
- Child: link each ticket as a GitHub sub-issue. If unavailable, add it to a task list in the map and put `Part of #<map>` at the top of its body. Use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`.
- Blocking: use native issue dependencies. Add an edge with `gh api --hostname github.com --method POST repos/oDestroyeRo/openrayrag/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Get the blocker's numeric database ID with `gh api --hostname github.com repos/oDestroyeRo/openrayrag/issues/<blocker> --jq .id`. If dependencies are unavailable, record `Blocked by: #<number>, #<number>` at the top of the child body.
- Frontier: in map order, choose the first open child with no assignee and no open blockers. Check `issue_dependencies_summary.blocked_by`, or the referenced blockers when using the fallback.
- Claim: assign the ticket to the driving developer before working; use `gh issue edit <number> --repo oDestroyeRo/openrayrag --add-assignee @me` when that is the authenticated user.
- Resolve: append the answer as a comment, close the child, then append its gist and link to the map's Decisions-so-far.
