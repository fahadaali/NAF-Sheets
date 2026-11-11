// Real Univer 1.4.0 drawing mutations, as an editor sends them: built by
// @univerjs/sheets-drawing's own `ISheetDrawingService` (the same calls its
// InsertSheetDrawingCommand / SetSheetDrawingCommand / RemoveSheetDrawingCommand
// make before executing `sheet.mutation.set-drawing-apply`), in a headless
// instance holding the same workbook state.

import { ICommandService, UniverInstanceType } from '@univerjs/core'
import type { IWorkbookData, Workbook } from '@univerjs/core'
import { ISheetDrawingService } from '@univerjs/sheets-drawing'
import { advanceHeadlessLifecycle, createModelUniver } from '../../src/room/engine'

export const DRAWING_MUTATION = 'sheet.mutation.set-drawing-apply'

export interface FloatingImage {
  drawingId: string
  source: string
  column: number
  row: number
  width?: number
  height?: number
}

/** An `ISheetImage` anchored at a cell (position anchor), as the editor's insert writes it. */
export function sheetImage(unitId: string, subUnitId: string, image: FloatingImage): Record<string, unknown> {
  const width = image.width ?? 120
  const height = image.height ?? 60
  const from = { column: image.column, columnOffset: 4, row: image.row, rowOffset: 2 }
  const to = { column: image.column + 1, columnOffset: 36, row: image.row + 2, rowOffset: 14 }
  return {
    unitId,
    subUnitId,
    drawingId: image.drawingId,
    drawingType: 0,
    imageSourceType: 'URL',
    source: image.source,
    transform: { left: 100, top: 50, width, height, angle: 0, flipX: false, flipY: false, skewX: 0, skewY: 0 },
    sheetTransform: { from, to, angle: 0, flipX: false, flipY: false, skewX: 0, skewY: 0 },
    axisAlignSheetTransform: { from, to, angle: 0, flipX: false, flipY: false, skewX: 0, skewY: 0 },
  }
}

/** Produces drawing mutations against a copy of `snapshot`, keeping that copy in step. */
export class DrawingOps {
  private readonly univer = createModelUniver('model')
  private readonly service: { getBatchAddOp(d: unknown[]): Op; getBatchUpdateOp(d: unknown[]): Op; getBatchRemoveOp(d: unknown[]): Op; getDrawingByParam(p: unknown): unknown }
  readonly unitId: string

  constructor(snapshot: Record<string, unknown>) {
    const wb = this.univer.createUnit<IWorkbookData, Workbook>(UniverInstanceType.UNIVER_SHEET, structuredClone(snapshot) as unknown as IWorkbookData)
    advanceHeadlessLifecycle(this.univer)
    this.unitId = wb.getUnitId()
    this.service = this.univer.__getInjector().get(ISheetDrawingService) as never
  }

  private mutation(op: Op, type: number) {
    const m = { id: DRAWING_MUTATION, params: { unitId: op.unitId, subUnitId: op.subUnitId, op: op.redo, objects: op.objects, type } }
    // Keep this copy in step, as the sender's own Univer would be.
    this.univer.__getInjector().get(ICommandService).syncExecuteCommand(m.id, structuredClone(m.params), { fromCollab: true })
    return structuredClone(m)
  }

  insert(subUnitId: string, image: FloatingImage) {
    return this.mutation(this.service.getBatchAddOp([sheetImage(this.unitId, subUnitId, image)]), 0)
  }

  /** Moves the image to another anchor cell (what a drag ends with). */
  move(subUnitId: string, drawingId: string, to: { column: number; row: number }) {
    const current = this.service.getDrawingByParam({ unitId: this.unitId, subUnitId, drawingId }) as Record<string, unknown>
    const moved = sheetImage(this.unitId, subUnitId, { drawingId, source: current.source as string, ...to })
    return this.mutation(this.service.getBatchUpdateOp([moved]), 2)
  }

  remove(subUnitId: string, drawingId: string) {
    return this.mutation(this.service.getBatchRemoveOp([{ unitId: this.unitId, subUnitId, drawingId }]), 1)
  }

  dispose(): void {
    this.univer.dispose()
  }
}

interface Op {
  unitId: string
  subUnitId: string
  redo: unknown
  undo: unknown
  objects: unknown
}
