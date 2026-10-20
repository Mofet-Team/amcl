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
  - **Who Stores to This** (editor context menu, also in `.LS` / `.LE`): on a LOCAL, a storage
    element, a point parameter (`REACT2.SP`) or a point, lists the programs that store to it,
    then those that read it, each with its line, and the box point (tag) at a box element.
    Moving through the list shows each place; Escape returns to where you were.
- Rename (F2) of LOCALs, constants, labels, steps, phases, handlers, subroutines and
  arguments, in their file only. A name already used in the file, a reserved word, a built-in or
  a point in the database is refused, and so is a step, phase, handler or subroutine name over 8
  characters outside CL/AM, and a name declared twice. Points and program names are not
  renamed. When other programs give a LOCAL the same name on the same storage, a message names
  them; their files are left as they are.
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
    - Points: a point used as `XV1.PV` or in a state change (`OPEN XV1`) that is not declared
      EXTERNAL; a state change of a LOCAL or of more than 16 points; and a word alone on a line.
      A state change is the one statement without a keyword, so stray words and typos read as
      one: `asdf qwer` is reported as an undeclared point QWER.
    - Names: an undeclared name where a value is needed, in arithmetic, AND/OR, conditions,
      indices, and in a store to a declared LOCAL (a LOGICAL takes ON or OFF, a state-list LOCAL
      its own states). A name compared with or stored to a point parameter may be one of the
      point's states, which the database does not always list, so it is not reported.
    - Structure: statements before the first STEP of a routine that has steps, a phase, step,
      handler or subroutine with no statements, and a sequence that INITIATEs itself.
    - CALL: the number of arguments (also for built-in functions and subroutines), at most 32,
      a variable for OUT and IN OUT, expressions only to built-in subroutines, constant indices,
      no element of an array argument passed on, the types of LOCALs and literals against the
      subroutine's, and a subroutine setting one of its IN arguments.

    None of these fires on the corpus of sources that compiled as they are.
  - Warnings, as the compiler gives them: names defined but not referenced (shown faded),
    strings over 64 characters, a LOOP never repeated.
  - Warnings from the point database, for errors the compiler would give; they are only as
    current as the database, so a point rebuilt as another type since the last compile shows
    here first: a parameter its point type does not have (from the HPM Parameters Pocket Guide
    and the PM Family Parameter Reference Dictionary), a store to a view-only parameter,
    INITIATE of a point that is not a process module, an EXTERNAL point on another UCN, more
    than 12 I/O module prefetches in a step, and a prefetched parameter in a PHASE ALARM clause
    or a CALL.
  - Code past column 132 (`line-length`): the compiler reads 132 columns and drops the rest of a
    line without a message. A ruler marks the column. `amcl.lineLength` sets a lower limit, for
    an editor or file transfer that cuts lines sooner; comments past it are not reported.
  - Warnings the compiler does not give: messages longer than the 60 characters the CRT shows,
    subroutines nested deeper than one level, `WAIT` on an absolute time, and access to a point
    the point database places in another node (only READ, WRITE and INITIATE reach it).
    Two LOCALs mapped on the same `NN` or `FL` element (`local-alias`): the compiler accepts
    the alias, but a store through one name changes the other. A name for an element of a LOCAL
    array is only noted.

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
    messages, and **Go to Definition** from a message to its line in the source.
  - A listing navigates like its source: hovers on tags, points and LOCALs, Go to Definition,
    references, highlights, folding, and the program's units, phases and steps in the outline.
    An `.LS` holds the whole compiled source, so this works on the listing itself; an `.LE` holds
    only the lines with errors, so it works through the source file beside it.
  - Notes, such as "All enabled abnormal handlers are disabled", are hints: dots in the editor
    with the message on hover, not entries in the Problems panel.
  - **CL: Compare with Last Compile** (the compare button on a CL editor, the right-click menu
    in the editor, on its tab and on the file, or a program in CL Programs) opens a diff of the source the `.LS` shows, which is what
    was compiled, against the file now, with the compile date in the title. Lines the listing
    cut at its page width are taken from the file where they start the same. An `.LE` holds only
    the lines with errors, so a file with only an `.LE` cannot be compared.
  - Codes `compiler-error`, `compiler-warning`, `compiler-note` and `compiler-stale`. Compiler
    warnings the extension reports itself (unused names, for example) are shown once.
- Formatting, only on request (**Format Document**, Shift+Alt+F, or **Format Selection**), in
  the file's own style: each kind of line (unit headings, PHASE, STEP, declarations, statements,
  labels, ELSE, END) goes to the column the file uses most for it, and continuation lines move
  with their statement. Trailing spaces go and keywords are capitalized. Comments, strings,
  column-1 `&` and `%`, and alignment within a line stay as they are; no line is moved past
  column 132, and a result that would lex differently is not applied.

  Rules for a folder go in a `.clformat.json`; the nearest one above a file applies, and what it
  does not set is learned from the file. **CL: Create Formatting Rules from This File** writes
  one with the columns of the open file:

  ```json
  {
    "columns": { "unit": 4, "phase": 4, "step": 0, "declaration": 4, "statement": 4, "label": 0, "end": 4 },
    "trimTrailingSpaces": true,
    "uppercaseKeywords": true,
    "maxLineLength": 132
  }
  ```
- **Inlay hints**: after each use of a LOCAL, the storage element it is mapped onto (`NN(12)`,
  `!BOX.FL(3)`); for an array, the element (`A(2)` is `NN(6)`) or the range it covers
  (`NN(5..7)`). After each use of a point (once per line, after the whole `TAG.PV`), its EXTERNAL
  entry and the bound point, its descriptor from the point database, or its `[type]` when it
  has none. They show while Ctrl+Alt (Ctrl+Option on a Mac) is held; to show them always, set
  `"[cl]": { "editor.inlayHints.enabled": "on" }`. `amcl.inlayHints.locals` and
  `amcl.inlayHints.points` turn each kind off.
- **CL Programs** view in the Explorer: every program of the workspace by where it runs, LCN and
  HPM (UCN/node), then each program's phases with their steps, handlers and subroutines. A
  click opens the code. Programs marked red have errors in their `.LE`; yellow ones changed
  since the compile that wrote their listing. Listings are read only for the HPMs you open.
- **Quick fixes** (Ctrl+. or the light bulb): add an undeclared point to EXTERNAL (on an `&` line
  when the list is full, or a new EXTERNAL above the LOCAL that needs it); remove an unused
  LOCAL, constant, EXTERNAL point or label (its statement keeps its column; LOOP labels stay);
  continue a line past column 132 on an `&` line, between tokens, or move code indented past it;
  put a space between a Hebrew state and THEN, AND or OR; declare an undefined name as a LOCAL
  (LOGICAL on a flag when it is used as a condition, else a number) on the first slot of the
  sequence's point that neither the file nor another program uses, or change it to a declared
  name a letter or two away.
- **CL Shared Storage** view in the Explorer: every box variable, sequence slot and array
  element that two sequences or more use (copies of one program count once), or that one uses
  and a box Numeric or Flag point (a tag) names, since displays and other systems read and write
  it through the tag. The tag and its descriptor come first; by LCN and HPM,
  then by owner: box flags, numerics, times and strings, each sequence's slots, and arrays. An
  element shows the LOCAL names it goes by and how many sequences store to it; opened, it lists
  each program with the LOCAL it uses and how often it stores and reads, and a click goes there.
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
### 0.10.2

- Inlay hints on LOCAL arrays: `A(2)` shows its element, `NN(6)`, and the whole array or a
  variable subscript the range, `NN(5..7)`. Bounds given by constants (`LOCAL CNT=19+1`) count.
- Point descriptors show only for EXTERNAL entries alone on their line, so packed lists no
  longer run past column 132; a point without a descriptor shows its type in brackets.

### 0.10.1

- Windows: a file open in the editor was also indexed under a second spelling of its path, so
  references, programs and other names for a storage element could show twice, and deleted or
  discarded files stayed in the index.
- A file nested too deep for the checks no longer stops the language server; it is logged and
  its checks are skipped.
- Formatting never moves code across column 132, whatever `maxLineLength` or `amcl.lineLength`
  allow: the compiler drops what is past it without a message.
- Point database files with NUL bytes in their fields are read instead of skipped.

### 0.10.0

- Inlay hints: after each use of a LOCAL, the storage element it is mapped onto (`NN(12)`,
  `!BOX.FL(3)`); after each EXTERNAL entry and the bound point, its descriptor from the point
  database. In CL files they show while Ctrl+Alt (Ctrl+Option on a Mac) is held;
  `amcl.inlayHints.locals` and `amcl.inlayHints.points` turn each kind off.

### 0.9.2

- Two LOCALs mapped on the same `NN` or `FL` element are reported (`local-alias`): a warning,
  or a note when one is an array and the other names one of its elements.

### 0.9.1

- Who Stores to This (editor context menu, also in `.LS` / `.LE`): the programs that store to a
  LOCAL, storage element, point parameter or point, then those that read it, each with its line.
- Rename (F2) of LOCALs, constants, labels, steps, phases, handlers, subroutines and arguments,
  in their file only, with the new name checked against the file, reserved words, built-ins and
  the point database.

### 0.8.1

- An undeclared name stored to by SET or READ is reported, and the quick fix declares it as a
  LOGICAL flag or a number by the value stored.

### 0.8.0

- Quick fixes for undeclared points and names, unused declarations and labels, lines past
  column 132, and Hebrew written against THEN, AND or OR.
- Each HPM the point database does not place is a group of its own, named by a point bound in
  it, under "HPMs not in the point database": storage of different HPMs no longer shows as one.

### 0.7.1

- CL/AM blocks, and programs of HPMs missing from the point database, are listed under the LCN
  of the points they use; failing that, under the LCN most programs in their folder are on,
  marked as a guess in the tooltip. The rest are grouped under "LCN not known".

### 0.7.0

- **CL Programs** view: every program by LCN and HPM, with its phases and steps, handlers and
  subroutines, and its compile status from the listings (errors in an `.LE`, or changed since
  the compile).
- **CL Shared Storage** view: box variables, sequence slots and array elements two sequences or
  more use, or one uses under a tag, with who stores and who reads.
- **Compare with Last Compile**: the source the `.LS` shows against the file now, in a diff.
- Outline: phases are listed beside their sequence, so they show while the outline starts
  collapsed; entries name their CL kind (SEQUENCE, PHASE, STEP, SUBROUTINE, HOLD HANDLER...),
  and a phase shows the handlers its heading enables.

### 0.6.1

- Formatting, on request only, in each file's own style: each kind of line goes to the column
  the file uses most for it, with rules for a folder in `.clformat.json` and the command
  **CL: Create Formatting Rules from This File**.
- Stray words are reported: `asdf` alone, or `asdf qwer`, which reads as a state change of an
  undeclared point.
- Points used without an EXTERNAL, and undeclared names where a value is needed, are reported.
- An IF without THEN is reported once instead of once per word after it.
- Listings opened on their own start the extension.

### 0.5.0

- Compiler errors caught while editing, checked against sources that compiled: LOCAL locations
  and types, loop counters and REPEATs, handler types and RESTART sections, PHASE headings,
  routine structure, and CALL arguments.
- With the point database: parameters a point type does not have, stores to view-only
  parameters, INITIATE of points that are not process modules, EXTERNALs on another UCN, and
  I/O prefetch limits.
- Code past column 132, which the compiler drops without a message; `amcl.lineLength`.
- Compiler listings: `.LS` and `.LE` messages on the source lines they are about, `.LE` errors of
  every source in the Problems panel, and the ~400 compiler messages explained on hover.
- Listings navigate like their source: hovers, go to definition, references and an outline of
  units, phases and steps. Old CL/AM listing layouts are read in full.
- A warning when the point database or network folders hold nothing on this machine.
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
