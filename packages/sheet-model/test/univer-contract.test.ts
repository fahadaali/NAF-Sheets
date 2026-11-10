// Every Univer value this package mirrors (src/univer.ts) checked against the
// installed 1.4.0 packages. Raising the @univerjs/* pin makes this file fail
// until the mirrors are checked again (CLAUDE.md: never raise the pin silently).

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  BooleanNumber,
  CellValueType,
  DataValidationType,
  DateSystem,
  FormulaType,
  IResourceManagerService,
  LocaleType,
  RANGE_TYPE as UNIVER_RANGE_TYPE,
  Univer,
  UniverInstanceType,
} from '@univerjs/core'
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula'
import { deserializeListOptions, serializeListOptions, UniverSheetsPlugin } from '@univerjs/sheets'
import { SHEET_CONDITIONAL_FORMATTING_PLUGIN } from '@univerjs/sheets-conditional-formatting'
import { CHECKBOX_FORMULA_1, CHECKBOX_FORMULA_2, DATA_VALIDATION_PLUGIN_NAME, transformCheckboxValue } from '@univerjs/sheets-data-validation'
import { SHEET_FILTER_SNAPSHOT_ID } from '@univerjs/sheets-filter'
import { UniverSheetsNotePlugin } from '@univerjs/sheets-note'
import { describe, expect, it } from 'vitest'
import { splitAssigneeText } from '../src'
import {
  BOOL,
  CELL_TYPE,
  CHECKBOX_DEFAULT,
  DATE_SYSTEM,
  DV_TYPE,
  FORMULA_TYPE_ARRAY,
  RANGE_TYPE,
  RESOURCE,
  ROW_INDEPENDENT_RESOURCES,
  UNIVER_VERSION,
} from '../src/univer'

const require = createRequire(import.meta.url)
function installedVersion(pkg: string): string {
  const entry = require.resolve(pkg)
  return (JSON.parse(readFileSync(join(entry.slice(0, entry.lastIndexOf('/lib/')), 'package.json'), 'utf8')) as { version: string }).version
}

describe('installed Univer', () => {
  it('is the version the mirrors were read from', () => {
    for (const pkg of [
      '@univerjs/core',
      '@univerjs/engine-formula',
      '@univerjs/sheets',
      '@univerjs/sheets-note',
      '@univerjs/sheets-data-validation',
      '@univerjs/sheets-conditional-formatting',
      '@univerjs/sheets-filter',
    ]) {
      expect(installedVersion(pkg), pkg).toBe(UNIVER_VERSION)
    }
  })
})

describe('mirrored values', () => {
  it('match the core enums', () => {
    expect(BOOL).toEqual({ FALSE: BooleanNumber.FALSE, TRUE: BooleanNumber.TRUE })
    expect(CELL_TYPE).toEqual({ STRING: CellValueType.STRING, NUMBER: CellValueType.NUMBER, BOOLEAN: CellValueType.BOOLEAN, FORCE_STRING: CellValueType.FORCE_STRING })
    expect(DV_TYPE).toEqual({ CHECKBOX: DataValidationType.CHECKBOX, LIST: DataValidationType.LIST, LIST_MULTIPLE: DataValidationType.LIST_MULTIPLE })
    expect(DATE_SYSTEM).toEqual({ D1900: DateSystem.Date1900, D1904: DateSystem.Date1904 })
    expect(RANGE_TYPE).toEqual({ NORMAL: UNIVER_RANGE_TYPE.NORMAL, ROW: UNIVER_RANGE_TYPE.ROW, COLUMN: UNIVER_RANGE_TYPE.COLUMN, ALL: UNIVER_RANGE_TYPE.ALL })
    expect(FORMULA_TYPE_ARRAY).toBe(FormulaType.ARRAY)
  })

  it('match the checkbox defaults and value comparison of sheets-data-validation', () => {
    expect(CHECKBOX_DEFAULT).toEqual({ checked: CHECKBOX_FORMULA_1, unchecked: CHECKBOX_FORMULA_2 })
    expect(transformCheckboxValue('TRUE')).toBe('1')
    expect(transformCheckboxValue('false')).toBe('0')
  })

  it('read multiple-choice lists the way sheets does', () => {
    const names = ['سارة', 'Omar Ali']
    expect(serializeListOptions(names)).toBe(JSON.stringify(names))
    expect(splitAssigneeText(serializeListOptions(names))).toEqual(deserializeListOptions(serializeListOptions(names)))
    expect(splitAssigneeText('سارة,Omar Ali')).toEqual(deserializeListOptions('سارة,Omar Ali'))
  })

  it('name the resources the plugins register', () => {
    expect(RESOURCE.DATA_VALIDATION).toBe(DATA_VALIDATION_PLUGIN_NAME)
    expect(RESOURCE.CONDITIONAL_FORMATTING).toBe(SHEET_CONDITIONAL_FORMATTING_PLUGIN)
    expect(RESOURCE.FILTER).toBe(SHEET_FILTER_SNAPSHOT_ID)
    const univer = new Univer({ locale: LocaleType.EN_US, locales: { [LocaleType.EN_US]: {} } })
    try {
      univer.registerPlugin(UniverFormulaEnginePlugin)
      univer.registerPlugin(UniverSheetsPlugin)
      univer.registerPlugin(UniverSheetsNotePlugin)
      // Plugins register their resource hooks when the first sheet unit starts them.
      univer.createUnit(UniverInstanceType.UNIVER_SHEET, { id: 'x', name: 'x', appVersion: UNIVER_VERSION, locale: LocaleType.EN_US, styles: {}, sheetOrder: [], sheets: {} })
      const names = univer
        .__getInjector()
        .get(IResourceManagerService)
        .getAllResourceHooks()
        .map((h) => h.pluginName as string)
      expect(names).toContain(RESOURCE.NOTE)
      expect(names).toContain(RESOURCE.RANGE_PROTECTION)
      expect(names).toContain(RESOURCE.DEFINED_NAME)
      for (const name of ROW_INDEPENDENT_RESOURCES) expect(names, name).toContain(name)
    } finally {
      univer.dispose()
    }
  })
})
