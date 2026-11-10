// Arabic texts of the realtime collaboration UI (spec §11, §12.2).

export const collabText = {
  /** Banner while disconnected (spec §11: read-only with a banner). */
  offline: 'انقطع الاتصال بالخادم، فالملف للقراءة فقط الآن. ستُستأنف المزامنة تلقائياً عند عودة الاتصال.',
  offlineTitle: 'غير متصل',
  connecting: 'جارٍ الاتصال بالملف للتحرير المشترك…',
  resyncing: 'جارٍ تحميل أحدث نسخة من الملف…',
  /** The room refused this page for good (old page, file gone). */
  failedTitle: 'توقّف التحرير المشترك',
  reloadPage: 'إعادة تحميل الصفحة',
  /** Fallback: the room could not be joined; edits are saved the old way. */
  unavailable: 'تعذّر الاتصال بالتحرير المشترك، فلن تظهر تعديلات الآخرين هنا لحظياً. تُحفظ تعديلاتك كالمعتاد؛ وإن كان غيرك يحرّر الملف الآن فلن يُقبل الحفظ، فأعد تحميل الصفحة بعد قليل.',
  /** A message the room or the client sent (refused edit, dropped edits, lock refused). */
  noticeTitle: 'التحرير المشترك',
  dismiss: 'إغلاق',
  /** Shown on a cell another person is editing. */
  lockedBy: (name: string | null) => (name ? `يحرّر ${name} هذه الخلية الآن. انتظر حتى ينتهي ثم أعد المحاولة.` : 'يحرّر شخص آخر هذه الخلية الآن. انتظر حتى ينتهي ثم أعد المحاولة.'),
  /** Label of the avatars list. */
  peers: 'المتصلون الآن',
  /** A connected person, for the avatar's label. */
  peer: (name: string | null, editing: boolean, readOnly: boolean) => `${name ?? 'مستخدم'}${readOnly ? ' (للقراءة فقط)' : ''}${editing ? ' — يحرّر خلية الآن' : ''}`,
  /** The room status beside the title. */
  status: {
    connecting: 'جارٍ الاتصال',
    live: 'متصل',
    sending: 'جارٍ الإرسال',
    resyncing: 'جارٍ التحديث',
    offline: 'غير متصل',
    failed: 'متوقّف',
  },
  /** More people than the avatars shown. */
  more: (n: number) => `+${n}`,
} as const
