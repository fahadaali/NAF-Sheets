# النسخ الاحتياطي والاستعادة

> **المرجع:** المواصفات §14 «نسخ احتياطي: لقطات R2 بإصدارات + تصدير D1 يومي»، و§15 المرحلة 7.
> **الكود:** `apps/api/src/phase7/backup.ts`، والجدولة في `apps/api/src/background.ts` و`apps/api/wrangler.toml`.
> **الحالة:** منفَّذ ومختبَر على Miniflare المحلي فقط (`apps/api/test/phase7/backup.test.ts`). **لم يُشغَّل على Cloudflare بعد**، ولم تُجرَّب الاستعادة على قاعدة حقيقية.

## 1. ما يحميه النظام أصلاً

- **لقطات الملفات في R2 بإصدارات.** كل حفظ يكتب كائناً جديداً `workbooks/{id}/snapshots/{version}.json` بكتابة «إنشاء فقط»، ولا يُستبدل إصدار سابق ولا يُحذف (`apps/api/src/snapshot.ts`). فالشق الأول من §14 متحقق داخل الحاوية `naf-sheets-snapshots` نفسها.
- **سجل التدقيق** (`audit_log`) لا يقبل التعديل ولا الحذف بمشغّلات في قاعدة البيانات.
- **لا حذف في التشغيل العادي**: الصفوف تُؤرشف (`archived_at`، `revoked_at`، `removed_at`) ولا تُحذف.

## 2. ما يضيفه النسخ الاحتياطي اليومي

مهمة مجدولة يومياً في **00:23 UTC (03:23 بتوقيت الرياض)**، تكتب في حاوية **منفصلة** `naf-sheets-backups` (الربط `BACKUPS`):

| المسار في حاوية النسخ | المحتوى |
|---|---|
| `d1/{run}/schema.json` | تعريف الجداول والفهارس والمشغّلات (`sqlite_master`) |
| `d1/{run}/{table}/{page}.ndjson` | كل صفوف كل جدول، 1000 صف في الصفحة، سطر JSON لكل صف |
| `d1/{run}/r2-inventory/{page}.ndjson` | جرد كل كائنات حاوية اللقطات: المفتاح والحجم و`etag` وتاريخ الرفع |
| `snapshots/workbooks/{id}/snapshots/{v}.json` | نسخة من **آخر** لقطة لكل ملف غير مؤرشف |
| `snapshots/templates/{id}/snapshot.json` | نسخة من لقطة كل قالب غير مؤرشف |
| `d1/{run}/manifest.json` | الأعداد، ويُكتب **آخراً**: تشغيلٌ بلا `manifest.json` لم يكتمل |

- كل كتابة «إنشاء فقط» (`onlyIf: etagDoesNotMatch '*'`): لا يُستبدل شيء ولا يُحذف شيء. واللقطة المنسوخة من قبل (المفتاح نفسه) لا تُنسخ مرة أخرى.
- كل تشغيل يُسجَّل في الجدول `backup_runs` (بدء، نهاية، حالة، أعداد، رمز الخطأ دون أي محتوى)، ويراه `admin` في شاشة **صحة المزامنة** («آخر نسخة احتياطية») وفي `GET /api/admin/backups`.
- إن لم تكن الحاوية مربوطة يُسجَّل التشغيل «لم تُنفَّذ» (`skipped`, `no_bucket`) ولا يُكتب شيء.
- **الرموز:** أعمدة `encrypted_tokens` تُنسخ كما هي، أي نصاً مشفّراً بمفتاح `TOKEN_ENCRYPTION_KEY` الذي لا يدخل النسخة. ورموز الواجهة الداخلية مخزّنة بصيغة SHA-256 فقط. لا يُكتب أي رمز صريح في النسخة.

## 3. الإعداد (مرة واحدة)

```bash
cd apps/api
npx wrangler r2 bucket create naf-sheets-backups   # الحاوية مذكورة أصلاً في wrangler.toml
npx wrangler d1 migrations apply naf-sheets --remote   # يضيف الجداول templates وapi_tokens وbackup_runs (0005_phase7.sql)
npx wrangler deploy                                # يسجّل جدولة "23 0 * * *" بجانب "*/15 * * * *"
```

لا سرّ جديد لهذه المهمة.

## 4. التحقق بعد أول تشغيل

1. شاشة **الإعدادات ← صحة المزامنة**: «آخر نسخة احتياطية … اكتملت».
2. أو من سطر الأوامر:

```bash
npx wrangler d1 execute naf-sheets --remote --command "SELECT id, status, started_at, finished_at, error FROM backup_runs ORDER BY started_at DESC LIMIT 3"
npx wrangler r2 object get naf-sheets-backups/d1/<run>/manifest.json --file manifest.json
```

## 5. الاستعادة (إجراء يدوي — لا يُنفَّذ آلياً أبداً)

> الاستعادة تكتب فوق بيانات حيّة. **لا تُنفَّذ إلا بموافقة صريحة من المالك**، وعلى قاعدة جديدة أولاً.

**قاعدة البيانات D1**

1. اختر التشغيل: أحدث `d1/{run}/` فيه `manifest.json`.
2. أنشئ قاعدة **جديدة** (لا تستعد فوق الحالية): `npx wrangler d1 create naf-sheets-restore`.
3. طبّق الترحيلات عليها: `npx wrangler d1 migrations apply naf-sheets-restore --remote` (يعيد المخطط نفسه؛ قارنه بـ `schema.json`).
4. حمّل الصفوف جدولاً جدولاً من ملفات `ndjson` (كل سطر صفّ بأسماء أعمدته) بأوامر `INSERT`، **بترتيب المفاتيح الأجنبية**: `members` ← `workbooks` ← `workbook_members`, `sheets` ← `column_mappings`, `tasks` ← `task_assignees`, ثم البقية. و`audit_log` يُحمَّل كما هو (المشغّلات تمنع التعديل والحذف فقط، لا الإدراج).
5. تحقق من الأعداد مقابل `manifest.json`، ثم بدّل `database_id` في `wrangler.toml` إلى القاعدة المستعادة بعد الموافقة.

> **OPEN (B1):** لم يُكتب سكربت تحميل آلي لأن طريقة الاستعادة الرسمية لم تُحسم: Cloudflare توفّر لـ D1 الاستعادة الزمنية (Time Travel، `wrangler d1 time-travel restore`) والتصدير (`wrangler d1 export`). أيّهما المعتمد، ومدة الاحتفاظ، قرار للمالك.

**اللقطات R2**

- اللقطات في الحاوية الأصلية لا تُحذف، فالاستعادة غالباً لا تحتاجها. إن فُقدت الحاوية: انسخ `snapshots/…` من حاوية النسخ إلى المسار نفسه بلا البادئة `snapshots/` في حاوية جديدة، ثم اربطها بـ `SNAPSHOTS`. تحقّق أن `current_snapshot_version` لكل ملف يشير إلى إصدار موجود.

## 6. خارج ما نُفّذ (قرارات مفتوحة)

| # | السؤال | الافتراضي الآمن الآن |
|---|---|---|
| B1 | الاستعادة الرسمية لـ D1: Time Travel، أم `wrangler d1 export`، أم هذا التصدير؟ | التصدير اليومي هنا، والاستعادة يدوية |
| B2 | مدة الاحتفاظ بالنسخ | لا حذف أبداً؛ الحاوية تكبر يومياً (قاعدة دورة حياة في R2 قرارٌ للمالك) |
| B3 | حاوية في حساب Cloudflare آخر أو منطقة أخرى | الحساب نفسه |
| B4 | المرفقات (`ATTACHMENTS`) وKV (`SETTINGS`) | غير منسوخة: المواصفات تذكر لقطات R2 وD1 فقط |
| B5 | نسخ كل إصدارات اللقطات لا آخرها فقط | آخر إصدار لكل ملف يومياً، والجرد يسجّل الباقي |
