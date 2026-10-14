# amcl README

Basic support for Honeywell's AM/CL language.
Working Effectively with Legacy Code.

## Features

Covers CL/HPM, CL/APM and CL/PM sequences and CL/AM blocks, packages, custom data segments,
parameter lists and enumerations.

- Syntax highlighting for `.CL` sources and for `.LS` / `.LE` compiler listings
- Outline and breadcrumbs: SEQUENCE › PHASE › STEP › labels, handlers, subroutines, declarations
- Go to definition, find references and highlight for labels (`GOTO`, `REPEAT`), steps
  (`GOTO STEP`), phases (`GOTO PHASE`, `RESUME PHASE`), handlers (`ENB`, PHASE headings),
  subroutines (`CALL`), LOCAL variables and constants, EXTERNAL points, CDS parameters and
  `DEFINE` functions
- Across the workspace:
  - Go to definition on a point name opens the program bound to it and its point database
    record. Find references lists every file that uses the point.
  - Storage is followed across programs. `LOCAL X AT REACT2.NN(41)` goes to the LOCAL that
    REACT2 maps on `NN(41)`. Find references on `LOCAL F AT !BOX.FL(21)` lists every sequence
    and AM block that reads or writes that box flag, whatever they call it: `!BOX.FL(21)`,
    `$NM01N09.FL(21)`, `$NM01B09.FL(21)`, a Flag point's `.PV`, or an Array point element.
  - Workspace symbol search (Ctrl+T) over programs, phases, steps, handlers, subroutines and
    every point in the database.
- Hover:
  - On a point: its type, descriptor, HPM and slot, unit, EU, keyword, associated display, states
    (DigComp `STATETXT`), its point database entry, and the program bound to it.
  - On a LOCAL: its declaration and comment, the storage it is mapped on, the database point at
    that box element, and the names other programs give the same element.
  - On an I/O point: its channel (`!AI06S04 (HLAI)`); on a DigComp or controller: its wiring
    (`In: !DI16S06.PVFL · Out: !DO31S05.SO`).
  - On a hardware name such as `!DI11S01`: the points built on or wired to that channel in the
    program's HPM. Go to definition opens their database entries, and workspace symbol search
    (Ctrl+T) finds points by I/O address, such as `DI16S06`.
  - Hebrew descriptors, which the TPS stores in visual order, are shown in logical order
    (`amcl.hebrewDescriptors`).
- Signature help in `CALL` and function calls: subroutine arguments with IN/OUT and types,
  `DEFINE` functions and built-ins.
- Hover on a parameter (`XV1.MODATTR`): its meaning, states and workspace use. Hover on
  built-ins: signature and description.
- Completion:
  - After `tag.`: the parameters of that point type, ranked by how often the workspace uses them,
    with their meaning and states.
  - After `tag.OP =`, `tag.PV <>` and similar: the point's own states (`STATETXT`), or the
    standard states of MODE, MODATTR, PROCMOD, timer commands and other enumerations.
  - After a state word (`CLOSE `): the declared points that have that state first.
  - On an `EXTERNAL` line: the points in the program's own HPM, from the point database.
  - After `GOTO`, `GOTO STEP`, `GOTO PHASE`, `REPEAT`, `CALL` and `ENB HOLD`: labels, steps,
    phases, subroutines and handlers.
  - Elsewhere: LOCALs with their mapping (`LOGICAL AT FL(32)`) and comment, points with their
    descriptor, built-in functions and keywords.
- Folding for units, phases, steps, declarations, continued statements and comment banners
- Problems as you type, each with a code you can switch off in `amcl.diagnostics.disabled`:
  - Errors: syntax; undefined labels, steps, phases, handlers and subroutines; END names that
    do not match; storage out of range (`NN(81)`, box index above 4095); names over 8
    characters; AND/OR mixed without parentheses; declarations after the first PHASE; duplicate
    names; statements the dialect does not have (WAIT in CL/AM, WHEN ERROR in CL/PM, DEFINE in
    CL/HPM); the bound point named in EXTERNAL; `/` or MOD in a constant; LOOP without a label.
  - Errors the compiler would give, caught before compiling:
    - LOCALs: a location that is not NN, FL, TIME or STRn (NN or FL in CL/PM), a type that does
      not fit it (`LOGICAL AT NN`), a non-integer index, several names in one LOCAL ... AT, a
      state list without exactly two states, array bounds that do not rise, and a LOCAL on a
      point declared EXTERNAL later or not at all.
    - Loops: a counter that is not a declared scalar Number, a range that counts down, a REPEAT
      whose label is not a LOOP, and a second REPEAT of one loop.
    - Handlers: a handler named with the wrong type in ENB or a PHASE heading, a type twice in
      one ENB or heading, KEEPENB with handlers, two ALARM clauses, a RESTART in an EMERGENCY
      handler or twice in one handler, RESUME outside RESTART, a GOTO STEP across RESTART, and
      WHEN ERROR on INITIATE of the program's own handler.
    - Structure: statements before the first STEP of a routine that has steps, a phase, step,
      handler or subroutine with no statements, and a sequence that INITIATEs itself.

    None of these fires on the corpus of sources that compiled as they are.
  - Warnings, as the compiler gives them: names defined but not referenced (shown faded),
    strings over 64 characters, a LOOP never repeated.
  - Warnings the compiler does not give: messages longer than the 60 characters the CRT shows,
    subroutines nested deeper than one level, `WAIT` on an absolute time, and access to a point
    the point database places in another node (only READ, WRITE and INITIATE reach it).

  Checked against compiler listings: on files whose source matches their `.LS` listing, the
  extension reports every "Defined But Not Referenced" warning the compiler gave, at the same
  line and column, with no others, and no error on code the compiler accepted.
  `node dist/compare.js <cl-dir> [eb-dir]` repeats the comparison.
- Compiler listings. The `.LS` listing of every compile and the `.LE` error listing of a failed
  one, when they sit next to the source:
  - Their errors, warnings and notes show on the source lines they are about, also after the
    source was edited: a message follows its line by text, and messages on lines changed since
    the compile are counted on line 1. Each links to its place in the listing.
  - Errors from `.LE` files show in the Problems panel for every source, open or not, so
    **F8** steps through all failed compiles. An `.LE` is ignored once a newer clean `.LS`
    exists.
  - In an open listing: squiggles at the compiler's carets, an outline of the messages by
    severity, a hover that names the compiler pass and severity of each of the ~400 compiler
    messages, and **Go to Definition** from a listing line to that line in the source.
  - Codes `compiler-error`, `compiler-warning`, `compiler-note` and `compiler-stale`. Compiler
    warnings the extension reports itself (unused names, for example) are shown once.
- Snippets, comment toggling, bracket matching

## Requirements

Nothing special.

## Point database

Point the extension at the `.EB` files exported from the TPS point database (DEB Exception
Build) with the `amcl.pointDatabase` setting, for example:

```json
"amcl.pointDatabase": ["~/tps/points"]
```

`.EB` files inside the workspace are read automatically. The database tells the extension which
HPM each sequence runs in, so `!BOX` in two sequences on the same HPM is recognised as the same
box. Without it, the HPM is inferred from `LOCAL ... AT other_sequence.NN(i)` mappings, which are
only allowed within one HPM.

## Several LCNs

UCN numbers are only unique within an LCN, so two LCNs can each have an "HPM 01/09". The
extension tells them apart without configuration: a CL program can only name points on its own
LCN, so the point database folders whose points one file references are on one LCN. To show the
LCNs by name, point `amcl.networkConfig` at their network configuration files:

```json
"amcl.networkConfig": ["~/tps/network"]
```

With `A/sys/NCF.XX` and `B/sys/NCF.XX` there, hovers show `HPM 01/09 (LCN A)`. Each group of
folders is matched to the LCN whose NIMs serve its UCN numbers.

## Development

```sh
npm install
npm run install-local -- work   # build, package and install into the 'work' VS Code profile
                                # (no argument: the Default profile); then Reload Window
npm run build        # bundle dist/client.js and dist/server.js
npm test             # unit tests, fuzzing, and an end-to-end LSP test
npm run lint         # ESLint; CI runs lint, typecheck and tests on every push
npm run corpus -- <dir> --verified   # parse a directory of CL sources
node dist/probe.js <cl-dir> <eb-dir> [FILE.CL LOCAL]   # index statistics; trace one LOCAL's storage
```

To work on the extension, open this folder in VS Code and press F5 (**Run Extension**): it starts
a watch build and a VS Code window running the extension from source. After an edit, run
**Developer: Reload Window** in that window. **Attach to Language Server** debugs the server.

`npm run corpus` parses every `.CL` file under a directory. With `--verified` it checks only files
whose source matches the source column of their `.LS` listing, which compiled as they are, so any
error it reports there is a bug in the parser.

To release, bump `version` in `package.json`, commit, and push a tag `v<version>`: CI checks the
code, builds `amcl.vsix` and attaches it to a draft GitHub release.

## Defaults for CL files

The extension sets these for the `cl` language only. Override them under `"[cl]"` in your settings.

* `files.encoding`: `windows1255` (Hebrew). CL sources carry Hebrew bytes in strings and comments.
* `editor.insertSpaces`: `true`. CL allows only printable ASCII, so tab characters are illegal.
* `editor.tabSize`: `4`
* `outline.collapseItems`: `alwaysCollapse`. The Outline view opens folded to the programs,
  handlers and subroutines. To have it highlight where the cursor is, tick **Follow Cursor** in
  the Outline view's `…` menu.


## Known Issues

Bug reports are welcome!

## Release Notes
### Unreleased

- About 25 compiler errors caught while editing: LOCAL locations and types, loop counters and
  REPEATs, handler types and RESTART sections, PHASE headings, and routine structure.
- Compiler listings: `.LS` and `.LE` messages on the source, workspace-wide `.LE` errors in the
  Problems panel, and diagnostics, outline, hover and go to source inside listings.
- ESLint, and a CI workflow that checks every push and builds the package for a tagged release.

### 0.4.0

- Language server: outline, go to definition, references, highlights, folding and diagnostics.
- `.LS` / `.LE` listings are a separate language, so they are not checked as source.
- Diagnostics checked against the compiler's own listings: unused names, string and message
  length, storage ranges, mixed AND/OR, dialect rules, duplicates, subroutine nesting, and access
  to other nodes. `amcl.diagnostics.disabled` turns individual checks off.
- Completion of point parameters and states, database points, labels, steps, phases, handlers,
  subroutines, LOCALs and built-ins.
- Hover with point descriptors from the point database, storage aliases, and declaration
  comments.
- Outline groups LOCALs by storage (box numerics, flags, times; numerics; in other sequences...)
  and lists box timers.
- Workspace index: cross-file definition and references for points and storage (bound-point
  slots, box variables, Array points, box Numeric and Flag points), workspace symbols, and the
  `amcl.pointDatabase` setting for `.EB` point database exports.

- Editor defaults are scoped to CL files. Before, they changed settings for every language.
- CL files open and save as windows-1255, so Hebrew text survives a round trip.
- Spaces instead of tabs.
- Grammar rewritten against the CL/HPM and CL/AM reference manuals: correct keywords (READ, MOD,
  IN, ...), built-ins, time units, labels of any length, `""` in strings, state-change statements,
  and tag highlighting based on syntax instead of tag-name prefixes.
- Removed the broken keybinding and the unused `amcl.enableColorDataPoints` setting.

### 0.2.5

Update default settings
### 0.2.4

Update grammar
### 0.1.2

Installation from VXIS added
### 0.1.1

Bug fixes

### 0.0.1

 Initial release

### For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
