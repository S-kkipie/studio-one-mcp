# Command catalog (sub-project A) — design

Date: 2026-10-07
Status: direction approved in chat ("ok sigue el A"; user asked how to expose ~1,400 commands without 1,400 tools). Written spec.

## Goal

Let Claude find and run any of Studio One's ~1,429 commands, including commands that take arguments. The commands cover menus, context menus, Musical Functions, and Audio, Track and Event edits. Claude should be able to do this without guessing names, and the tool list stays as it is.

1. **Discover:** natural-language search in English or Spanish, e.g. "transponer una octava", "quantize 16ths", "duplicar pista". The results come ranked, each with its arguments and whether it can run right now.
2. **Inspect:** the full argument schema of one command. That is each argument's type, range, enum labels and defaults, plus real examples taken from macros.
3. **Run:** `live_command` accepts `command: "Category/Name"` and `args` as an object. Argument names are validated (with suggestions) and enum labels are mapped to values.
4. **CLI:** `studio-one-mcp cmd find|info|run|refresh`, so Claude Code, or a person, can drive commands from a shell with `--help` (progressive disclosure through Bash).

## Research: how to expose many commands (2026)

- Loading every tool definition up front wastes context and lowers selection accuracy. MCP's client best practices recommend **progressive discovery**: a *search* layer returns candidate names, an *inspect* layer returns the full schema of one candidate, and an *execute* layer runs it.
- Claude Code already defers MCP tool schemas behind ToolSearch once they pass a token threshold. Our ~67 tools are therefore cheap, but 1,429 tools would still drown search and selection.
- "Code mode" and CLIs let an agent discover capabilities by itself (`--help`, files) and keep intermediate output out of context.

**Decision:** never one tool per command. Use three layers on the existing server:
- `live_find_command` (search);
- `live_command_info` (inspect);
- `live_command` (execute; already exists, extended).

The same three layers are exposed as CLI subcommands. The catalog is data, built automatically from the running Studio One and its install, so new Studio One versions and new edit tasks need no code change.

## Spike facts (2026-10-07, Studio One 7.2.3)

| Fact | Consequence |
|---|---|
| `Host.GUI.Commands.newCommandIterator()` yields 1,429 commands. Each has `category`, `name`, `displayCategory` and `displayName` (localized, Spanish here), `classID` and `arguments`, a comma list (272 commands) or `"..."` (27 edit-task commands). | The bridge `listCommands` returns these fields when `detail: true`. |
| `<install>/Scripts/*.package` = `"PACKAGEF"` + zlib streams + a directory at the end. Each entry is `"File"`, then u32 type, then a UTF-16LE name ending in `00 00`, then 9 bytes (date), then u64 offset, u64 compressed size and u64 uncompressed size. The first offset is 8. | `src/commands/packages.js` reads the packages offline. |
| Each package has a `classfactory.xml` with `<ScriptClass classID category="EditTask" subCategory name sourceFile functionName>` and `<Attribute id="arguments" value="..."/>`. | Joins to the command iterator's `classID` and names the source file. |
| Each source `.js` declares its arguments: `parameters.addInteger(min, max, "Name")`, `addFloat(min, max, "Name")`, `addParam("Name")` (boolean), `addString("Name")`, `addList("Name")`, and `add(Host.Classes.createInstance("Media:VelocityParam" \| "Media:BeatListParam" \| "Media:BeatListParamZero"))` assigned to `this.<Name>`. A later `this.Name.value = 60` sets the default. | Static schema extraction (types, ranges, defaults). |
| The package skin XML (`<Form name="TransposeDialog" ...>`) has `<RadioButton name="Mode" value="0" title="Add"/>` and `<ToolButton name="AddValue" value="12" title="+1 Oct"/>`. | Enum labels and named presets for each argument. |
| `~/Documents/Studio One/Macros/*.studioonemacro` (224 files on this machine, built-in and user) holds `<CommandElement category name><CommandArgument name value/>`, covering 90 distinct commands with real values. | Examples, plus argument names for commands that have no script (e.g. `Sound Variation/Find and Apply Variation :: Name`). |

## Architecture

```
src/commands/
  packages.js    readPackage(file) → Map<name, Buffer>   (directory + zlib; pure)
  schemas.js     extractEditTaskSchemas(installDir) → { [classID]: { task, args:[{name,type,min,max,default,choices?,presets?}] } }
  macros.js      readMacroExamples(dirs) → { "Cat/Name": [{ title, args:{…} }] }
  catalog.js     buildCatalog({ live, schemas, examples }) → catalog; load/save ~/.studio-one-mcp/commands/catalog.json
  search.js      searchCommands(catalog, query, { limit }) → ranked [{ command, displayName, args, score }]
  synonyms.js    small curated Spanish/English synonym map (transponer↔transpose, cuantizar↔quantize, pista↔track, …)
  run.js         normalizeArgs(entry, args) → flat [k, v, …]; validation + enum-label mapping
```

- **Live source:** the bridge `listCommands { detail: true }` returns `[{ category, name, displayCategory, displayName, classID, arguments }]`.
  - This is a device change and needs a Studio One restart, as before.
  - If an older device does not send `detail`, the catalog falls back to category/name only and says so.
- **Catalog entry:**
  - `{ command: "Cat/Name", category, name, displayName, displayCategory, args: [...], variableArgs: bool, examples: [...], source: ["live","script","macro"] }`
  - Declared argument names (`arguments`) become `args` of type `"unknown"` unless the script or macros give more.
  - Arguments seen only in macros are added with their observed values as examples.
- **Cache:** one file, `~/.studio-one-mcp/commands/catalog.json` (`{ schema, builtAt, install, live: bool, commands, warnings }`). It is built on first use, rebuilt by `refresh: true` / `cmd refresh`, and rebuilt automatically when it is older than 24 h, or was built without live data, and Studio One answers.
  - Building takes a single `listCommands` call (~1–2 s) plus offline parsing.
  - If Studio One is not running, a cached catalog is still searchable.
- **Search:**
  - Lowercase and accent-fold everything, then tokenize. The fields searched are `name`, `category`, `displayName` and `displayCategory`, plus synonyms expanded from the query.
  - **Score:**
    - exact `Cat/Name` gets 100;
    - each query token that appears in the name weighs 3, in the displayName 3, in the category 1, and in an argument name or enum label 1;
    - a full phrase match in the name or displayName adds 5.
  - Ties are broken by shorter name.
  - The results are the top `limit` entries (default 10, max 50).
  - With `enabled_only` or `with_state`, each hit gets `enabled` from `command checkOnly`, so the result says what applies to the current selection or editor (the automatic context).

### Tools (server.js)

- `live_find_command { query, limit?, with_state? }`
  - Returns `{ results: [{ command, displayName, args: "Mode(Add|Set all to), AddValue(-64..64), SetValue(0..127)", enabled? }], catalog: { commands, builtAt, source } }`.
  - The description tells Claude to search first and then run with `live_command`.
- `live_command_info { command }`
  - Returns the full entry: args with type, range, default, choices `{value, label}` and presets; the macro examples; and `enabled` now.
  - For an unknown command it returns "not found" plus the top 5 search suggestions.
- `live_command` (extended):
  - It accepts either `{category, name}` or `command: "Cat/Name"`.
  - `args` may be the old flat array or an object `{ Mode: "Set all to", SetValue: 60 }`.
  - Object args are validated against the catalog:
    - an unknown argument name is an error that lists the valid names;
    - an enum label maps to its value, case- and accent-insensitive;
    - a number outside min..max is an error;
    - booleans become 1/0;
    - for `"..."` commands with no known schema, names pass through unchecked, with a warning.
  - Missing arguments are not invented. Studio One uses the task's last-used values, and the description says so.
- `live_list_commands` stays for compatibility. Its description points to `live_find_command`.

### CLI (cli.js)

```
studio-one-mcp cmd find <words…> [--limit N] [--state]
studio-one-mcp cmd info <Category/Name>
studio-one-mcp cmd run <Category/Name> [--Arg value …] [--check]
studio-one-mcp cmd refresh
```

- Output is human-readable text by default and `--json` for scripts.
- The CLI uses the same `src/commands/*` and `bridge.call` (the mailbox), so it works whenever the MCP server would.
- The exit code is non-zero on error.

## Error handling

- Studio One is not running:
  - `find` and `info` work from the cache (with `enabled` omitted and a note);
  - with no cache, they report "start Studio One once to build the command catalog".
- No install found (non-standard path): edit-task schemas are skipped, and declared argument names and macros still apply. `STUDIO_ONE_INSTALL` overrides the install path.
- Package parsing errors are per file: that package is skipped and listed in `catalog.warnings`.
- A command that runs and returns `executed: false` is reported as "not available in the current context (needs a selection / open editor?)". The result includes `enabled` from checkOnly.

## Testing

- **Unit:**
  - `readPackage` on a tiny synthetic package (two zlib files plus a directory) built in the test;
  - schema extraction from source and skin snippets (addInteger/addFloat/addParam/add(Media:VelocityParam), defaults, RadioButton choices, ToolButton presets);
  - the macro parser;
  - catalog merge (live + script + macro, and live-only fallback);
  - search ranking (exact > phrase > tokens; Spanish synonyms; accent folding);
  - `normalizeArgs` (unknown name, enum label, range, boolean, flat-array passthrough);
  - CLI argument parsing;
  - tool schemas.
- **Live, on `mcp-prueba`, after the device update and restart:**
  - build the catalog: ≥ 1,400 commands, with arguments for Musical Functions/Transpose (Mode choices Add/Set all to);
  - `find "transponer octava"` lists Musical Functions/Transpose first or in the top 3;
  - `info` on Transpose;
  - select a part's notes and run `Musical Functions/Transpose {Mode:"Add/Subtract", AddValue:12}`, check the pitches went up 12, then `live_undo`;
  - `cmd find quantize --state` from the CLI.

## Out of scope

- Running native modal dialogs (Export Mixdown and other dialog-only commands). That is sub-project B.
- Editing or creating macros.
- Per-command hand-written docs. The curated part is only the small synonym map.
