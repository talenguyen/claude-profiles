# Shared sessions: `share-sessions`

Back to the [command reference](commands.md) or [auto mode](auto-mode.md).

```sh
claude-profiles share-sessions [--dry-run] [--rollback] [<profile>...]
claude-profiles share-sessions --dry-run tech personal
claude-profiles share-sessions tech personal
```

Let the named profiles share session history, so `use --auto --continue` or
`use --auto --resume <id>` continues the same conversation on a different
profile. It is opt-in per profile; which profiles share is your choice, and
profiles you do not name keep their history private. With no names it acts on
the profiles that already share.

**What is shared.** `projects/` (transcripts, per-project memory, large tool
results) and `file-history/` (rewind data) of each opted-in profile become
links to one folder, `~/.config/claude-profiles/shared/` (mode `0700`, beside
the profile configs, never inside a project repo). History stays scoped per
project folder inside it, exactly as Claude lays it out. Not shared:
`history.jsonl` (up-arrow prompt recall) stays per profile, and so do
credentials, `sessions/`, `session-env/` and everything else. The base
`~/.claude/projects` used by plain `claude` is not included.

**Data crossing, in plain words.** Continuing a conversation on another
profile re-sends the whole conversation to Anthropic on *that profile's
account*: every prompt and reply, every tool result (file contents, command
output, connector data such as Slack or Drive), and the project memory. Work
content continued on a personal account therefore goes to that account, under
that account's terms and privacy settings; the other direction puts personal
content into an organization account its admins may be able to see. Team and
Enterprise plans do not train on your data by default; Pro and Max plans depend
on a privacy setting you control. Check the current terms before relying on
this. Only opt in profiles you are comfortable crossing that line for. Sharing
also means every opted-in profile reads and writes the same per-project memory.

**Migrating existing history.**

1. **Exit every Claude session** for the profiles you are about to share, in
   every terminal. The command refuses while any Claude process for them is
   alive (it checks each profile's `sessions/<pid>.json`), because a transcript
   moved while it is being written would split the session.
2. `claude-profiles share-sessions --dry-run <profile>...` shows how many files
   would be copied and lists anything blocking, changing nothing.
3. `claude-profiles share-sessions <profile>...` merges each profile's existing
   `projects/` and `file-history/` into the shared folder as a union. A file
   that exists in several profiles is kept once when the copies are identical,
   or, for direct `projects/<slug>/<session-id>.jsonl` transcripts only, when
   one is an older prefix of another. Memory, tool-result, subagent, and
   `file-history/` files must be byte-identical; any other difference aborts
   before changing anything and lists the paths. Resolve those by hand.
   Then each profile's old folder is renamed to `projects.pre-share` (and
   `file-history.pre-share`) and replaced by a link to the shared folder.
   Copies are APFS clones on macOS, so this is fast and takes no extra space
   until files change. The backups stay until you delete them. The profile is
   then marked `sessions: shared` in the registry. Running it again changes
   nothing.
4. `claude-profiles share-sessions --rollback [<profile>...]` removes the links
   and restores each `.pre-share` backup, so a profile gets back exactly the
   history it had before. Sessions created after the migration stay in the
   shared folder, since they cannot be attributed to one profile; the command
   reports how many. `--dry-run` previews a rollback too.

Profiles marked shared are linked automatically when `use` or `refresh` finds
their `projects/` or `file-history/` missing. A real folder with private
sessions is never merged silently: `use` prints a notice to run
`share-sessions`. A link that points anywhere else is refused.

**Concurrent use.** Two Claude processes appending to different sessions are
safe, as they are in one profile today. Two profiles resuming the *same*
session at the same time are not: they create branches, Claude follows only
one, and the other's turns silently drop out of the conversation. Do not run
one session in two terminals. `--fork-session` (see [auto-mode.md](auto-mode.md)) avoids the hazard
by writing each continuation to its own session, at the cost of one extra
transcript per switch. Claude's startup transcript cleanup, run by
whichever profile starts first, now prunes the shared folder for all of them
(retention comes from the shared `settings.json`).

When a session ends on a usage limit, its last prompt has no real answer;
re-send it (or type "continue") on the new profile.
