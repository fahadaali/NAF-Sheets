// Dependent lists get one Univer rule per cell (Univer 1.4.0 does not move
// list formulas; G32), up to DEPENDENT_LIST_CELL_LIMIT cells per sheet.
// Beyond it the remaining cells keep the first cell's list, reported.
// SYNTHESISED: fixtures/excel-dropdowns.ts with column B stretched.

import { describe, expect, it } from 'vitest'
import { DEPENDENT_LIST_CELL_LIMIT, importXlsx } from '../src'
import { buildExcelDropdownFixture } from './fixtures/excel-dropdowns'

describe('dependent list cap', () => {
  it('copies the list per cell up to the limit, then keeps the first formula and reports it', async () => {
    const rows = DEPENDENT_LIST_CELL_LIMIT + 50
    const r = await importXlsx(await buildExcelDropdownFixture(rows), { workbookId: 'wb', via: 'upload' })
    const dv = JSON.parse(r.workbook.resources?.find((x) => x.name === 'SHEET_DATA_VALIDATION_PLUGIN')?.data ?? '{}')['sheet-1'] as Array<{ formula1?: string; ranges: unknown[] }>
    const indirect = dv.filter((x) => x.formula1?.startsWith('=INDIRECT('))
    // The first cell keeps the formula as written, the next DEPENDENT_LIST_CELL_LIMIT cells their own,
    // and the cells over the limit share the first one's rule.
    expect(indirect).toHaveLength(DEPENDENT_LIST_CELL_LIMIT + 1)
    expect(indirect.find((x) => x.formula1 === '=INDIRECT($A2)')?.ranges.length).toBeGreaterThan(1)
    expect(indirect.some((x) => x.formula1 === `=INDIRECT($A${DEPENDENT_LIST_CELL_LIMIT + 2})`)).toBe(true)
    const item = r.report.items.find((i) => i.kind === 'data_validation' && i.message.includes(String(DEPENDENT_LIST_CELL_LIMIT)))
    expect(item).toMatchObject({ outcome: 'converted', detail: '=INDIRECT($A2)', location: expect.objectContaining({ ref: `'Main'!B2:B${rows + 1}` }) })
  })
})
