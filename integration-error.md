# Workspace integration failure after session restore

## Summary

Workspace `task-2026-09-29T01-33-31-254Z-250338e4` correctly targeted
`~/Documents/projects/pi-console`, but Pi refused to re-enter or integrate it
after this conversation was restored from history following an operating-system
restart.

The project cwd was not changed to the dotfiles repository. The dotfiles path
shown in diagnostics was the location of the Pi session file.

## Observed mismatch

The workspace record stored this owner session path:

```text
/Users/inwon/.pi/agent/sessions/--Users-inwon-Documents-projects-pi-console--/2026-09-29T00-40-36-633Z_01a0ea9b-3a19-72e3-8ab4-84786911dd1b.jsonl
```

After restoration, `ctx.sessionManager.getSessionFile()` returned:

```text
/Users/inwon/dotfiles/pi/agent/sessions/--Users-inwon-Documents-projects-pi-console--/2026-09-29T00-40-36-633Z_01a0ea9b-3a19-72e3-8ab4-84786911dd1b.jsonl
```

`~/.pi` is a symlink to `/Users/inwon/dotfiles/pi`. `realpath` resolved both
paths to the same file, and `ls -i` reported the same inode. The workspace
extension nevertheless compared the two path strings with strict equality, so
it treated the restored conversation as a different owner.

The restart/history restore likely changed whether the session path was
reported through the `~/.pi` symlink or its resolved dotfiles path. The direct
cause is confirmed; the exact restore step that canonicalized the path was not
traced.

## Recovery

Before integration, the workspace record's `sourceSessionFile` was rebound to
the current session path only after verifying that both paths resolved to the
same file. Pi then recognized the task workspace as belonging to this
conversation.

## Destination merge conflict

The first integration attempt after recovery found a separate modify/delete
conflict in `TODO.md`: the destination checkout had deleted the file, while the
task workspace had removed its two completed entries and left it empty. The
task's `TODO.md` change was omitted so integration preserves the destination's
deletion.

## Preventive change

Workspace ownership now canonicalizes session-file paths before storing or
comparing them. Equivalent symlink and resolved paths therefore identify the
same conversation, while paths to different session files remain distinct.
