// Pictures in Univer 1.4.0's open-source drawing plugins (@univerjs/drawing,
// drawing-ui, docs-drawing, sheets-drawing, sheets-drawing-ui, all Apache-2.0),
// as the editor uses them (apps/web OPEN_QUESTIONS.md I1–I8):
//
// - the plugins of @univerjs/preset-sheets-drawing, with one change: Univer's
//   image service (`IImageIoService`, which turns a file into a base64 data
//   URL in the snapshot) is replaced by `PlatformImageIoService`, which
//   uploads the file to the platform and gives Univer its URL. Univer's own
//   «صورة» menu (over the cells / in a cell) is the way in; moving, resizing,
//   ordering and deleting are Univer's, and reach the room as
//   `sheet.mutation.set-drawing-apply` (floating) or a cell value (in a cell);
// - the worksheet background picture is hidden and refused: its mutation is
//   not one the room accepts (packages/shared room-protocol.ts).

import { IImageIoService, ImageSourceType, ImageUploadStatusType, generateRandomId } from '@univerjs/core'
import type { IImageIoServiceParam, Nullable } from '@univerjs/core'
import type { FUniver } from '@univerjs/presets'
import {
  ImageIoService,
  UniverDocsDrawingPlugin,
  UniverDrawingPlugin,
  UniverDrawingUIPlugin,
  UniverSheetsDrawingPlugin,
  UniverSheetsDrawingUIPlugin,
} from '@univerjs/preset-sheets-drawing'
import { IMAGE_MAX_BYTES } from '@naf-sheets/shared'
import { t } from '../strings'
import { uploadImage } from './image-upload'

/** Univer's background-picture menu and commands: not offered (their mutation is not synced). */
const BACKGROUND_MENU = 'sheet.menu.worksheet-background-image'
const BACKGROUND_COMMANDS = new Set(['sheet.command.add-worksheet-background-image', 'sheet.command.set-worksheet-background-image'])

/** Thrown to Univer after the platform already showed its own message (Univer then shows none). */
const HANDLED = 'naf-image-handled'

/**
 * Univer's image service with uploads to the platform: the picture is stored
 * once (R2) and the drawing keeps its same-origin URL (`ImageSourceType.URL`).
 * `base64Cache` is a local object URL, which Univer only uses to measure the
 * picture before inserting it; it never reaches the snapshot.
 */
export class PlatformImageIoService extends ImageIoService {
  constructor(
    private readonly workbookId: string,
    private readonly onRefused: (message: string) => void,
  ) {
    super()
  }

  override async saveImage(file: File): Promise<Nullable<IImageIoServiceParam>> {
    const result = await uploadImage(this.workbookId, file)
    if (!result.ok) {
      this.onRefused(result.message)
      throw new Error(HANDLED)
    }
    return {
      imageId: generateRandomId(6),
      imageSourceType: ImageSourceType.URL,
      source: result.url,
      base64Cache: URL.createObjectURL(file),
      status: ImageUploadStatusType.SUCCUSS,
    }
  }
}

export interface ImagePresetOptions {
  workbookId: string
  onRefused: (message: string) => void
}

/** The drawing plugins, as @univerjs/preset-sheets-drawing registers them, with the platform's image service. */
export function nafDrawingPreset(options: ImagePresetOptions) {
  const io = new PlatformImageIoService(options.workbookId, options.onRefused)
  return {
    plugins: [
      [UniverDrawingPlugin, { override: [[IImageIoService, { useValue: io }]], allowImageSize: IMAGE_MAX_BYTES }],
      UniverDocsDrawingPlugin,
      UniverDrawingUIPlugin,
      UniverSheetsDrawingPlugin,
      [UniverSheetsDrawingUIPlugin, { menu: { [BACKGROUND_MENU]: { hidden: true } } }],
    ],
  } as never
}

/** Refuses Univer's background-picture commands with an Arabic message. Returns the disposer. */
export function installImageGuard(univerAPI: FUniver, onRefused: (message: string) => void): () => void {
  const subscription = univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (raw) => {
    const event = raw as unknown as { id: string; cancel?: boolean; options?: { fromCollab?: boolean } }
    if (event.options?.fromCollab) return
    if (!BACKGROUND_COMMANDS.has(event.id)) return
    event.cancel = true
    onRefused(t.images.backgroundRefused)
  })
  return () => subscription.dispose()
}
