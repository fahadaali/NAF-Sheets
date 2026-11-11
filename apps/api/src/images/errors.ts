// Refusals of the image routes (contract: packages/shared/src/api-images.ts).
// Arabic: what happened, then what to do (spec §12.2).

import type { ApiError, ApiErrorCode } from '@naf-sheets/shared'
import { IMAGE_MAX_BYTES } from '@naf-sheets/shared'

export const IMAGE_MESSAGES = {
  forbidden_write: 'لا تملك صلاحية التعديل على هذا الملف، فلم تُضف الصورة. اطلب من مالك الملف أو مسؤول المنصة صلاحية التحرير.',
  length_required: 'لم يُرسل حجم الصورة مع الطلب، فلم يُحفظ شيء. أدرج الصورة من المنصة نفسها ثم أعد المحاولة.',
  image_empty: 'ملف الصورة فارغ، فلم يُحفظ شيء. اختر صورة أخرى ثم أعد المحاولة.',
  image_too_large: `حجم الصورة أكبر من ${IMAGE_MAX_BYTES / (1024 * 1024)} ميغابايت، فلم تُحفظ. صغّر الصورة أو اضغطها ثم أعد إدراجها.`,
  image_type_not_allowed: 'نوع الملف غير مقبول صورةً، فلم يُحفظ. المقبول: PNG وJPEG وGIF وWebP (لا تُقبل صور SVG لأنها قد تحمل نصوصاً برمجية). حوّل الصورة إلى أحد هذه الأنواع ثم أعد إدراجها.',
  image_not_found: 'لم يُعثر على هذه الصورة، أو ليس لك وصول إلى الملف الذي تتبعه. تأكّد من الرابط أو اطلب من مالك الملف إضافتك.',
  storage_failed: 'تعذّر حفظ الصورة في المنصة، فلم تُضف. أعد المحاولة بعد لحظات، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
} as const

export type ImageErrorKey = keyof typeof IMAGE_MESSAGES

const SHAPE: Record<ImageErrorKey, { status: number; code: ApiErrorCode }> = {
  forbidden_write: { status: 403, code: 'forbidden' },
  length_required: { status: 411, code: 'image_length_required' },
  image_empty: { status: 400, code: 'image_empty' },
  image_too_large: { status: 413, code: 'image_too_large' },
  image_type_not_allowed: { status: 415, code: 'image_type_not_allowed' },
  image_not_found: { status: 404, code: 'image_not_found' },
  storage_failed: { status: 500, code: 'internal' },
}

export class ImageFailure extends Error {
  override readonly name = 'ImageFailure'
  constructor(readonly key: ImageErrorKey) {
    super(key)
  }
  get status(): number {
    return SHAPE[this.key].status
  }
  body(): ApiError {
    return { ok: false, error: SHAPE[this.key].code, message: IMAGE_MESSAGES[this.key] }
  }
}
