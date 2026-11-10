# sheet-model — open questions

Places where `docs/spec.md` is silent, or where Univer 1.4.0 does not offer
what the spec assumes. Each is implemented with the narrowest safe behaviour,
marked `// OPEN:` in the code, and pinned by a test, so a decision shows up as
a deliberate test change. Nothing here has been tried in a browser with
`@naf-sheets/univer-rtl`; the headless Univer tests cover the model only.

## Univer cannot express it in the snapshot

1. **System columns are hidden but not protected.** Univer 1.4.0 can store a
   range protection rule (`SHEET_RANGE_PROTECTION_PLUGIN`, `IRangeProtectionRule`
   in `@univerjs/sheets`), but (a) with the open-source local authorisation
   (`AuthzIoLocalService`, core) the default owner may still edit the range, and
   (b) when it is enforced it also blocks sorting and moving whole rows:
   `sheets-sort-ui` and `SheetPermissionCheckController._permissionCheckByMoveRowsColsCommand`
   check `RangeProtectionPermissionEditPoint` over the moved rows — and the
   system cells must move with their row (§16 scenario 2). So no rule is
   written. Protection has to be enforced at run time: the editor refuses
   direct edits of the three columns (command interceptor), and the API refuses
   a saved snapshot whose uids changed other than by moving rows.
   **Needed:** confirm that split.

13. **Subtask indentation.** Univer 1.4.0 has no indent field in `IStyleData`;
    the only horizontal offset is padding `pd` (`IPaddingData`). The renderer
    honours `pd.l` for plain and rich text (engine-render `_renderText`,
    `_renderPlainTextWithoutClip`; core `createDocumentModelWithStyle`). With
    the mirrored grid model-left is the start side, so `pd.l` indents at the
    start, consistent with logical alignment (CLAUDE.md). It shows only when the
    title is start-aligned. **Not verified in a browser.** The pixel value is a
    caller option (`subtaskIndent`), from the theme.

14. **Hatched background.** Univer styles have a solid `bg` only. The snapshot
    carries the caller's `unsyncedStyle` and a cell note «لا يُزامَن مع Basecamp»;
    a hatch pattern and a hover tooltip must be drawn by the editor (custom
    render), which can find the cells by their `custom.nafSheets.marks.unsynced`.

18. **Platform data in `ICellData.custom`.** Marks (with the values they
    replaced), the notes cell's original HTML and the "deleted in Basecamp"
    status are kept in `custom.nafSheets`. Univer documents `custom` as "not
    recommended for external use". Verified: it survives a load and
    `Workbook.save()` in headless 1.4.0. Not verified: what copy/paste and
    autofill do with it (a pasted copy may carry a mark record).

## Placement and identity

2. **Where the system columns go.** After the last used column (cells, merges,
   formatted columns); nothing is inserted, so no formula, validation or format
   moves (verified headless). Side effects: whole-row references (`=COUNTA(2:2)`)
   and open ranges also count the hidden cells; a person who copies whole rows
   copies their uids (see #5); a person who pastes into the sheet past the
   last user column writes next to hidden columns.

5. **Duplicated uids** (a whole row copied with its hidden cells). Every copy
   is left out of `readTasks` with `duplicate_uid`; none is synced. Which copy
   keeps the identity and which gets a new uid is undecided. Duplicates across
   two sheets are not visible to this package: the API must check uniqueness
   (D1 `tasks.task_uid`).

## Reordering and new rows

3. **Sort semantics, not insert semantics.** A new row from Basecamp is written
   in the first row under the table and then sorted into place; a Basecamp
   reorder is a sort of the task rows. Exactly as after Univer's own sort
   (`ReorderRangeCommand`, sheets-formula `_reorderFormula`): formulas in moved
   rows shift their relative references with the row (`offsetFormula`, checked
   against `LexerTreeBuilder.moveFormulaRefOffset`), shared formulas are
   written out first, and formulas elsewhere keep their addresses (a summary
   `=D5` reads whatever row 5 holds afterwards). Validation, format and
   protection ranges follow the content row by row, so a range that ends at
   the last task row does not grow to cover a new row (a status checkbox on
   `E2:E10` does not reach a task added in row 11). Real row insertion would
   need Univer's reference-moving rules for every formula, defined name and
   plugin range in the workbook; it is not implemented.
   **Needed:** accept sort semantics, or decide to extend ranges that end at
   the last task row.

4. **No free row under the table.** When the row right under the last task
   holds anything (a total, a note), a new row is refused (`no_free_row`)
   rather than written over data or placed under the total.

16. **Cached values of other formulas.** Formula cells that move lose their
    cached value and are computed again on load (WHEN_EMPTY, the default of
    `@univerjs/sheets-formula`). Formulas elsewhere that depend on changed cells
    (a summary `COUNTIF` over the status column, §16 scenario 7) keep their
    cached value until Univer recalculates them. **Needed:** load workbooks in
    the editor with forced calculation, or mark those formulas dirty.

17. **Row settings follow the row.** Height and hidden flag (`rowData`) move
    with the content. Univer's own sort leaves them with the row position.

11. **Moving to another sheet.** Columns are matched by mapped field, then by
    equal header text. A row with a value in a column the target sheet does not
    have is not moved (`move_unplaced_cells`), nor is a row with formulas
    (`move_formula_cells`): their meaning in another layout is unknown. The row
    stays where it is; the API must hold that to-do (otherwise the next diff
    sees the old list and moves it back in Basecamp). Completion is read with
    the source column's rule and written with the target's.

## Spec silent

6. **Assignee cells.** The custom assignee editor (§5.2) does not exist yet,
   and D1 `task_assignees` is the single source of assignees. Cell text is
   split as Univer's multiple-choice list does (`deserializeListOptions`: JSON
   array, else commas) plus the Arabic comma and line breaks. Written back as
   Univer's JSON list in a multiple-choice column, else joined with «، ».
   Names compare after NFC, whitespace and Latin case folding; Arabic letter
   forms (أ/ا, ة/ه, ى/ي) are not folded. A follower or an automatic assignee
   keeps its kind only when the row state passes the stored assignees; the cell
   shows plain names (no follower or "automatic" marking).

7. **An external contact typed into the cell** gets `notifyEmail: false` until a
   person turns e-mail on (no e-mail is sent because of a cell parse).

8. **Plain text typed in the notes cell** becomes
   `<div>line<br>line</div>` (escaped). The markup Basecamp expects is unknown
   until the phase 0 live test. While the text still reads like the HTML that
   came from Basecamp, that HTML is returned unchanged (formatting and
   `bc-attachment`s survive).
   **Phase 5 (2026-11-10):** the description's files now survive *any* edit
   of the cell: edited text becomes new HTML followed by the stored
   `<bc-attachment>` elements, and a cleared cell keeps the files alone (an
   empty cell with the HTML in its platform data). The cell shows the text
   without the files (`notesText`). Only the attachment editor removes a file.
   Before this, editing the notes cell dropped every file from Basecamp.

9. **Un-completing a text status column.** When Basecamp un-completes a to-do
   whose status cell holds a "completed" value, the cell is cleared: which
   other value («قيد التنفيذ»، «متأخر»…) it should take is not known. Any
   other status text is left as it is.

10. **The «غير مصنّف» sheet** is created local (`mode: 'local'`, no list), with
    the source sheet's header row and column settings (not its validations or
    formats), named «غير مصنّف» or «غير مصنّف (2)»… if the name is taken. Its
    to-dos are no longer linked to a list in the platform (sync-engine
    OPEN_QUESTIONS #10).

12. **What the workbook room broadcasts.** `changedCells` lists every cell whose
    stored content changed and `changedResources` the plugin resources that
    changed; row settings and new sheets are not cells. The room protocol is
    phase 6 (spec §11, §17-2).

15. **Free columns appended to the description, on subtask rows.** A subtask
    has no description in Basecamp, so these do not sync either; only
    starts-on, notes and attachments (the three the §8 table lists) are marked.

19. **Status values** are compared like names (whitespace, case), not with the
    import wizard's label folding (diacritics, alef forms).

20. **Assign mode without the row state**: `manual` for a to-do with assignees,
    `auto` otherwise (§8.1's default for a new row). Pass D1's
    `tasks.assign_mode` through `rowState`.

21. **The attachments column** (phase 5): `update_row.fields.attachments`
    writes the file names, joined with «، » (`writeAttachmentNames`); an empty
    list clears the cell. The API writes it from D1 after every change; the
    column is never read back (the files live in D1 `attachments`). A new row
    writes the column only when it has files.

22. **Templates** (`toTemplateWorkbook`, phase 7): the system columns are
    found on the header row the caller gives (D1 `sheets.header_row`); a sheet
    whose system columns are incomplete or duplicated is left as it is and
    reported (`unreadableSheets`). Marks are removed with `removeMark`, so the
    person's own style comes back; `custom.nafSheets` is dropped whole
    (including `notesHtml`). The platform's notes are recognised by their id
    prefix `naf-unsynced-`.
