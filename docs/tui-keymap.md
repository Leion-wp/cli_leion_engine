# TUI Keymap V2 (Hybrid)

## Global
- `1..7`: switch tab
- `Shift+←` / `Shift+→`: previous/next tab
- Fallback terminal: `←` / `→` switch aussi les tabs si Shift n'est pas transmis
- `Tab` / `Shift+Tab`: cycle focus panels
- `Ctrl+K` or `/`: command palette
- `?`: help overlay
- `g` / `G`: jump first/last in focused list
- `R`: refresh active tab
- `F`: open filter prompt for active tab
- `C`: clear active tab filter
- `q` or `Ctrl+C`: quit

## Navigation
- `↑/↓` or `j/k`: move selection (or scroll by focused pane)
- `Enter`: confirm in palette/prompt/confirm
- `Esc`: cancel palette/prompt/confirm

## Tab Actions
- Run: `p` pause, `r` resume, `c` cancel, `l` refresh runs
- Pipelines: `Enter/r` run, `d` dry-run, `n` new, `x` delete, `e` editor
- Editor: `a` add, `x` delete, `u/j` reorder, `i/m/o/c` inline fields, `y` node YAML, `v` pipeline YAML (`j` is reserved to reorder down in this tab)
- Diff: `f` refresh
- Triggers: `s` start, `x` stop, `f` refresh
- HITL: `a` approve, `r` reject
