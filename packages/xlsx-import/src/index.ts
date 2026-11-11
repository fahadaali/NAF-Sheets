// .xlsx import (owner decision 2026-11-11): an uploaded Excel file, or a
// public Google Sheets file downloaded as .xlsx, read into the intermediate
// model of @naf-sheets/gsheets-import and converted by its converter.

export { importXlsx, sourceNameOf, type ImportXlsxOptions, type ImportXlsxResult } from './import'
export { readXlsx, type ReadOptions, type XlsxReadResult, type LocatedItem } from './read'
export { DEFAULT_XLSX_LIMITS, XlsxImportError, type XlsxErrorCode, type XlsxLimits } from './errors'
export { detectOrigin, type DetectedOrigin, type OriginSignals } from './origin'
export { isOleCompoundFile, isZip } from './zip'
export { columnPixels, rowPixels, DEPENDENT_LIST_CELL_LIMIT } from './sheet'
export {
  applyGoogleRendering,
  parseGoogleSheetChips,
  parseGoogleSheetIndex,
  sheetsWithDropdowns,
  type GoogleRendering,
  type RenderedChip,
  type RenderedSheet,
} from './google-rendering'
export { importPictures, type PictureImportCounts, type PictureStore } from './import-images'
export { readSheetPictures, readCellPictureIndex, pictureSize, EMU_PER_PIXEL, MAX_IMPORTED_PICTURES, type XlsxPicture } from './images'
export { applyTint } from './colors'
export { shiftFormula, stripFuturePrefixes, unwrapGoogleDummy, formulaBlockers } from './formula'
export { formatType, numberFormatFor } from './numfmt'
