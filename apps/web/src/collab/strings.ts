// Arabic texts of the realtime collaboration UI (spec §11, §12.2). Kept here,
// not in src/strings.ts, until the editor integration moves them there.

export const collabText = {
  /** Banner while disconnected (spec §11: read-only with a banner). */
  offline: 'انقطع الاتصال بالخادم، فالملف للقراءة فقط الآن. ستُستأنف المزامنة تلقائياً عند عودة الاتصال.',
  connecting: 'جارٍ الاتصال بالملف للتحرير المشترك…',
  resyncing: 'جارٍ تحميل أحدث نسخة من الملف…',
  /** Shown on a cell another person is editing. */
  lockedBy: (name: string | null) => (name ? `يحرّر ${name} هذه الخلية الآن` : 'يحرّر شخص آخر هذه الخلية الآن'),
  /** Label of the avatars list. */
  peers: 'المتصلون الآن',
} as const
