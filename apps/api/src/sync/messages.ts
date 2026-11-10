// Arabic messages of the sync (spec §12.2: what happened and what to do; no
// apology). Row messages go to `tasks.last_error` with their code in
// `tasks.last_error_code`; workbook notices to `WorkbookSyncResponse.notice`.

/** Codes of row states set by the API itself (sheet-model and sync-engine codes are used as they are). */
export const ROW_MESSAGES = {
  row_missing:
    'حُذف هذا الصف من الورقة دون تأكيد الحذف، فلم يُحذف شيء من Basecamp. أعد الصف بالتراجع (Ctrl+Z)، أو احذفه من جديد وأكّد الحذف.',
  actor_not_linked:
    'لم تُرسل تعديلات هذا الصف إلى Basecamp لأن حساب من عدّله غير مربوط بـ Basecamp. اربط حسابك من «اربط حسابك في Basecamp» ثم احفظ الصف من جديد.',
  actor_link_expired:
    'لم تُرسل تعديلات هذا الصف إلى Basecamp لأن ربط حساب من عدّله انتهت صلاحيته. أعد ربط حسابك في Basecamp ثم احفظ الصف من جديد.',
  actor_link_revoked:
    'لم تُرسل تعديلات هذا الصف إلى Basecamp لأن من عدّله ألغى ربط حسابه. أعد ربط حسابك في Basecamp ثم احفظ الصف من جديد.',
  not_configured: 'لم تُرسل تعديلات هذا الصف لأن ربط Basecamp غير مهيّأ في المنصة. أبلغ مسؤول المنصة ليكمل إعداده.',
  forbidden:
    'رفض Basecamp تعديل هذه المهمة لأن صلاحياتك هناك لا تسمح به (قد لا تكون عضواً في المشروع). اطلب من مدير المشروع في Basecamp إضافتك ثم احفظ الصف من جديد.',
  not_found:
    'لم يُعثر على المهمة في Basecamp أو ليس لحسابك وصول إليها، فلم يُرسل التعديل. تأكّد من عضويتك في المشروع؛ وستُحدَّث حالة المهمة في المطابقة الدورية.',
  validation_failed: 'رفض Basecamp قيم هذا الصف (مثل تاريخ أو مسؤول غير مقبول)، فلم يُرسل التعديل. صحّح القيم ثم احفظ الصف من جديد.',
  retries_exhausted:
    'تعذّر إرسال تعديلات هذا الصف إلى Basecamp بعد عدة محاولات، فبقيت في المنصة. اضغط «مزامنة الآن»، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  account_inactive:
    'حساب Basecamp غير نشط، فأُوقفت مزامنة الحساب كله ولم يُرسل شيء. أبلغ مسؤول المنصة ليراجع حالة الحساب في Basecamp ثم يستأنف المزامنة.',
  duplicate_across_sheets:
    'هذا الصف يحمل معرّف مهمة موجوداً في ورقة أخرى أيضاً (غالباً بعد نسخ صف كامل)، فلن يُزامَن أيٌّ منهما. احذف النسخة الزائدة أو تواصل مع مدير المنصة.',
  undo_impossible:
    'لا يمكن إعادة إنشاء هذه المهمة الفرعية في Basecamp لأن نسختها المحفوظة قبل الحذف غير متاحة. أنشئها من جديد في الورقة.',
  limit_reached: 'بلغ حساب Basecamp أحد حدوده (مثل عدد المستخدمين أو المشاريع)، فلم يُرسل التعديل. أبلغ مسؤول المنصة ليراجع حدود الحساب.',
  unexpected_response: 'ردّ Basecamp بما لا تتوقعه المنصة، فلم يكتمل إرسال هذا الصف. أعد المحاولة من «مزامنة الآن»، وإن تكرّر الخطأ فأبلغ مسؤول المنصة.',
  snapshot_required:
    'لم تُحذف المهمة الفرعية من Basecamp: حذفها نهائي، ويلزم حفظ نسخة كاملة منها قبل الحذف، وتعذّر جلبها. اضغط «مزامنة الآن» ثم احذف الصف من جديد.',
} as const

export type RowMessageKey = keyof typeof ROW_MESSAGES

/** TaskSyncInfo.message of a row in `conflict`. */
export const CONFLICT_ROW_MESSAGE =
  'عُدّلت هذه المهمة في المنصة وفي Basecamp قبل أن تتزامنا، فاعتُمد آخر تعديل. افتح التعارض لاستعادة القيمة الأخرى أو لإغلاقه.'

export const NOTICES = {
  account_inactive: ROW_MESSAGES.account_inactive,
  not_configured: 'ربط Basecamp غير مهيّأ في المنصة، فالمزامنة متوقفة. أبلغ مسؤول المنصة ليكمل إعداده.',
  service_not_linked:
    'حساب الخدمة في Basecamp غير مربوط، فلا تصل تعديلات Basecamp إلى هذا الملف. اطلب من مسؤول المنصة ربط حساب الخدمة.',
  webhook_pending:
    'لم يُفعَّل استقبال تعديلات Basecamp لهذا الملف بعد، فتصل تعديلات Basecamp في المطابقة الدورية كل 15 دقيقة. سيُعاد تفعيله تلقائياً.',
} as const

/** Actor recorded in sync_log for the one documented use of the service token on a write (§8.1). */
export const AUTO_RULE_ACTOR = 'قاعدة تلقائية'
/** Actor recorded for background steps that have no human author. */
export const SYSTEM_ACTOR = 'system'

/** Warnings of the link preview (§7.3), Arabic, with the 1-based row number. */
export const LINK_WARNINGS = {
  tooDeep: (row: number) =>
    `الصف ${row}: يبدو مستوى ثالثاً من المهام، وBasecamp يسمح بمستوى واحد من المهام الفرعية؛ سيُربط مهمة فرعية تحت مهمته الرئيسية.`,
  orphan: (row: number) => `الصف ${row}: يبدو مهمة فرعية ولا توجد فوقه مهمة رئيسية؛ سيُربط مهمة رئيسية.`,
  notUnderParent: (row: number) =>
    `الصف ${row}: مهمة فرعية لا تقع تحت مهمتها الرئيسية مباشرة؛ سيُربط مهمة رئيسية. انقله تحت مهمته الرئيسية قبل الربط إن أردته فرعياً.`,
  duplicateTitle: (title: string) =>
    `العنوان «${title}» مكرر في الورقة أو في قائمة Basecamp، فلم تُقترح له مطابقة؛ سيُنشأ مهمة جديدة.`,
  existingTodosKept: (count: number) =>
    `في قائمة Basecamp ${count} مهمة لا تقابلها صفوف؛ لن يُحذف منها شيء، وستظهر صفوفاً في الورقة بعد المزامنة.`,
  noStatusValues: 'عمود الحالة نصي ولم تُحدَّد القيمة التي تعني «منجزة»، فلن تُنجز أي مهمة من الورقة. حدّدها في خطوة «الحالة».',
} as const
