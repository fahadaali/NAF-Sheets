# Open questions — `@naf-sheets/gsheets-import`

Decisions the converter does not make. Each is marked `// OPEN:` in the code
with its number here. Until decided, the code takes the narrowest safe path
described under "Current behaviour"; tests pin that behaviour so a decision
shows up as a deliberate test change.

All of these need checking against a **real NAF Google Sheets file** (spec §15,
phase 2 acceptance), which has not been provided yet. The fixtures in
`test/fixtures/` are synthetic.

---

## 1. Left and right on right-to-left sheets

Our grid is mirrored (`@naf-sheets/univer-rtl`) and alignment is logical
(CLAUDE.md, owner decision 2026-11-10): model LEFT renders at the start, which
is the visual right on an RTL sheet. Google's API reference describes
`HorizontalAlign.LEFT` as "explicitly aligned to the left of the cell" and does
not say whether that is physical or logical when the sheet has
`rightToLeft: true`. The same question applies to `borders.left/right`,
`padding.left/right`, and the sign of `textRotation.angle` ("for LTR text
direction positive angles are in the counterclockwise direction, whereas for
RTL they are in the clockwise direction").

**Current behaviour:** pass-through, isolated in `src/rtl-open.ts`
(`mapHorizontalAlignment`, `mapLeftRightSides`): Google's value is written to
the Univer model unchanged on RTL and LTR sheets alike. A Google LEFT on an RTL
sheet therefore renders at the visual right on our grid. Rotation is written as
given. `test/rtl-open.test.ts` documents this.

**Needed:** open an RTL Google sheet, set a cell to "Left" (and a left border),
and record where Google draws it; then decide whether the import swaps.

## 2. Fonts and the spreadsheet's default format

Cell fonts are copied as given (`ff: "Arial"` etc.). Spec §4.1 makes Thmanyah
the platform font. `properties.defaultFormat` (Google: Arial 10, padding 2/3,
bottom alignment) is **not** applied as a workbook default style, so unformatted
cells use Univer's defaults (11 pt).

**Needed:** keep imported font families, drop them, or map them to Thmanyah?
Apply Google's default size (10 pt) to imported workbooks?

## 3. Functions with the same name but different arguments

Verified differences between Google (support.google.com/docs) and Univer 1.4.0
(`@univerjs/engine-formula`):

| Function | Google | Univer 1.4.0 | Current behaviour |
|---|---|---|---|
| IMAGE | `IMAGE(url, [mode], [height], [width])` | `IMAGE(source, [alt_text], [sizing], [height], [width])` | always value-only (spec §7.2 names it) |
| FILTER | `FILTER(range, condition1, [condition2, …])` | `FILTER(array, include, [if_empty])` | value-only when called with 3+ arguments |
| SORT | `SORT(range, sort_column, is_ascending, …)`, TRUE/FALSE | `SORT(array, [sort_index], [sort_order], [by_col])`, 1 or −1 | value-only when called with 3+ arguments |

Other same-name functions were not compared one by one (517 names). A Google
`SORT(range, C2:C26)` with a range as sort column is kept and will show
`#VALUE!` in Univer.

**Needed:** confirm the table; decide whether to compare more signatures
(e.g. `TEXT` format codes, `REGEX*`, `SPLIT`-like behaviour) against the real file.

## 4. Spilled results (array formulas, pivot tables, data source tables)

Cells with an `effectiveValue` but no `userEnteredValue` were produced by an
anchor. The converter attributes them to the anchor whose rectangle holds them:
the rectangle starts at the anchor and extends over the unbroken run of
produced cells to its right and below it. Produced cells of a **kept** formula
are left empty and the anchor is written without a cached value, so Univer
computes and spills it. Produced cells of anything **not kept** (unsupported
formula, pivot table, data source table) stay as static values. Produced cells
no anchor claims (gaps inside a result, results shaped irregularly) stay as
static values and are reported as `derived_value`.

**Risk:** a result with an empty first row/column is under-attributed; its
remaining cells stay static and, next to a kept spilling formula, cause
`#SPILL!` in Univer. They are listed in the report.

## 5. Alternating colours vs a cell's own fill

`bandedRanges` become static fills (spec §7.2). A cell's own background wins
over the band colour; the API reference does not state the precedence.

## 6. Case sensitivity of text conditions

Univer 1.4.0: conditional-format text rules compare **case-sensitively**
(`indexOf`, `===`); filter text matches are **case-insensitive** (wildcard
regexp with `i`). Google's behaviour is not stated in the API reference.
Mapped as is; matters only for Latin text.

## 7. Data-validation dates and unsupported conditions

- Date values are transferred only as `YYYY-MM-DD`, serial numbers or formulas.
  A date typed in the sheet's locale (e.g. `1/2/2026`) is ambiguous and is
  reported as not transferred.
- Not transferred (no Univer validator without inventing a formula):
  `TEXT_CONTAINS`, `TEXT_NOT_CONTAINS`, `TEXT_EQ`, `TEXT_IS_EMAIL`, `TEXT_IS_URL`,
  relative dates, and a checkbox with a single value.
- `allowBlank: true` on every rule: Google has no such option and accepts blanks.

**Needed:** should the text conditions become `custom` formulas
(e.g. `=ISNUMBER(SEARCH(...))`)? That changes their meaning slightly.

## 8. Hidden blanks in a filter

Google lists hidden values as displayed strings. The converter assumes a hidden
blank appears as `""` in `hiddenValues`; blanks stay visible otherwise. Not
stated in the API reference.

## 9. Links

`#gid=<sheetId>` links are rewritten to the Univer sheet id. Kept as they are:
links to a gid not in the file, named-range links (`#rangeid=…`), and full URLs
of the original Google file (`https://docs.google.com/spreadsheets/d/<same id>/…`),
which keep pointing at Google. Links on non-text cells and links set to
`PLAIN_TEXT` display are reported, not transferred.

**Needed:** rewrite links to the original file into in-platform links?

## 10. Header matching (wizard)

Synonyms are exactly those of spec §7.3 step 4. Matching folds diacritics,
tatweel, alef forms (so `تاريخ الانجاز` matches `تاريخ الإنجاز`), Latin case,
punctuation and spacing. It does **not** fold ة/ه, ى/ي or the definite article
(`مهمة` does not match `المهمة`). A synonym appearing as whole words inside a
longer header is a partial match (`Due date` → due_on) unless it matches more
than one field (`Task owner` stays free).

**Needed:** confirm the folding and partial matching, or extend the synonym list.

## 11. Hierarchy deeper than Basecamp allows

Basecamp 5 has one subtask level (spec §8). A third level (`1.1.1`, or a deeper
indent) is reported as `too_deep` and kept at level 1 under its top-level task;
a subtask with no preceding main task is reported as `orphan` and kept at
level 0. A numbering column is recognised only when **every** non-empty value
is a numbering and at least one is dotted.

**Needed:** flatten, reject, or ask per row?

## 12. Number formats

- A format with a type but no pattern (Google: "a default pattern based on the
  spreadsheet's locale") falls back to `effectiveFormat.numberFormat.pattern`;
  without it, the format is reported as not transferred.
- Google patterns are written unchanged; Univer reads Excel-style patterns.
  Differences in the dialect have not been checked against a real file.
- Dates are serial numbers in both. Google counts from 1899-12-30; Univer's
  1900 system matches for dates after 1900-02-28 only.

## 13. Images

Only `IMAGE()` formulas are visible in `spreadsheets.get`. Images placed over
the grid or inserted into cells are not in the API response, so they can be
neither transferred nor reported.

**Needed:** accept, or ask users to check images manually (a general note on
the report screen)?

## 14. Beyond the spec §7.2 table

Transferred though the table does not list them, because formulas or display
depend on them: named ranges (→ Univer defined names), hidden gridlines,
iterative-calculation settings. Reported though not listed: Google tables
(data and format kept, table properties not), row/column groups, comments,
smart chips, data-source sheets. Confirm.

## 15. Formula locale

The converter keeps formulas as the API returns them. The API reference does not
say whether a spreadsheet in an Arabic locale returns formulas with `,` or `;`
separators. Univer expects `,`. Check against the real file.

## 16. Row heights and column widths

`pixelSize` is copied as the row height / column width; the most common size in
each sheet becomes its default, so only exceptions are written. The API does
not say whether a Google row was sized automatically (wrapped text) or by hand,
and Univer's automatic row height measures text with its own fonts, so rows
with wrapped text may differ in height after import.
