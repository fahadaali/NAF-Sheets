# ربط المنصة بـ Cloudflare

> **الحالة:** نُشر الخادم أول مرة في 2026-11-11 (قبل دمج الواجهة فيه). الخطوات من §3 فصاعداً لم تُجرَّب بعد على الحساب.
> **المرجع:** المواصفات §4. قرار المالك 2026-11-11: **Worker واحد** اسمه `naf-sheets` يخدم الواجهة والخادم معاً على `sheets.naflaw.sa`، بدل مشروعَي Pages وWorkers في المواصفة.
> **الإعدادات:** `apps/api/wrangler.toml` و`scripts/deploy-api.sh`. الواجهة (`apps/web`) تُبنى في أمر النشر وتُرفع ملفاتٍ ثابتة للـ Worker نفسه.

## 0. الفروع

| الفرع | دوره |
|---|---|
| `main` | فرع الإنتاج: كل دفعة إليه تُنشر تلقائياً على Cloudflare |
| أي فرع آخر | فرع عمل؛ يُدمج في `main` بطلب دمج (Pull Request) بعد نجاح الاختبارات |

اجعل `main` الفرع الافتراضي في GitHub: **Settings → General → Default branch** ← `main`.

## 1. قبل البدء

1. يجب أن يكون النطاق `naflaw.sa` مُداراً في حساب Cloudflare نفسه (لازم لربط النطاق المخصص، §5).
2. النطاق الفرعي للمنصة: `sheets.naflaw.sa` (قرار المالك 2026-11-11، المواصفات §17-4). خطة الحساب مدفوعة (Workers Paid).
3. لا شيء يلزم على جهازك. كل ما يلي من لوحة Cloudflare.

## 2. الموارد: تُنشأ تلقائياً، ولا معرّفات في الكود

قرار المالك 2026-11-11: لا يُكتب في المستودع أي معرّف مورد ولا أي قيمة غير مقررة.

- **الموارد:** أول نشر للخادم (`wrangler deploy`) ينشئ ما ينقصه ويربطه بالخادم مباشرة: قاعدة D1 `naf-sheets`، ومساحتي KV ‏`AUTH_KV` و`SETTINGS`، وحاويات R2 الثلاث، والطوابير الأربعة. النشرات التالية تجدها بالاسم أو بالربط القائم، فلا يلزم إنشاء شيء يدوياً.
- **مخطط قاعدة البيانات:** يطبّقه أمر النشر نفسه (`scripts/deploy-api.sh`). في أول نشر يطبّقه بعد إنشاء القاعدة، وفي كل نشر بعده قبل نشر الكود.
- يبقى في `apps/api/wrangler.toml` ما قُرّر فقط: أسماء الموارد، و`AUTH_ISSUER`، و`PUBLIC_API_ORIGIN = "https://sheets.naflaw.sa"`، ومسارات النطاق.

## 3. المتغيرات والأسرار: في لوحة Cloudflare

تُضاف بعد أول نشر، من **Workers & Pages ← naf-sheets ← Settings ← Variables and Secrets**. `keep_vars = true` في `wrangler.toml` يمنع النشرات اللاحقة من حذفها.

| الاسم | النوع | القيمة |
|---|---|---|
| `PLATFORM_ID` | Text | اسم المنصة كما سُجّل في لوحة naf-id، حرفاً بحرف (حساس لحالة الأحرف). بدونه يفشل كل تسجيل دخول |
| `BASECAMP_ACCOUNT_ID` | Text | رقم حساب ناف في Basecamp |
| `GOOGLE_CLIENT_ID` | Text | معرّف تطبيق Google OAuth |
| `AUTH_CLIENT_SECRET` | Secret | من لوحة naf-id |
| `TOKEN_ENCRYPTION_KEY` | Secret | 32 بايتاً عشوائية بترميز base64، مثل ناتج `openssl rand -base64 32` |
| `BASECAMP_CLIENT_ID` | Secret | من تطبيق Basecamp |
| `BASECAMP_CLIENT_SECRET` | Secret | من تطبيق Basecamp |
| `GOOGLE_CLIENT_SECRET` | Secret | من Google Cloud |

النوع Secret يحفظ القيمة مشفّرة، ولا تظهر بعد حفظها، وهو المخزن نفسه الذي يكتب فيه `wrangler secret put`. لا تُكتب أي قيمة سرية في ملف أو محادثة.

لا تغيّر `TOKEN_ENCRYPTION_KEY` بعد أول استخدام: تغييره يُبطل رموز Basecamp وGoogle المحفوظة، فيعيد كل شخص الربط.

## 4. المشروع: Worker مربوط بـ GitHub

في لوحة Cloudflare: **Workers & Pages → Create → Import a repository** ← اختر `fahadaali/NAF-Sheets`. إن كان المشروع موجوداً فعدّل إعداداته من **Settings ← Build**.

| الإعداد | القيمة |
|---|---|
| Project name | `naf-sheets` (يجب أن يطابق `name` في `wrangler.toml`) |
| Production branch | `main` |
| Root directory | `/` (جذر المستودع: الخادم يحتاج حزم `packages/*`) |
| Build command | فارغ (أمر النشر يبني الواجهة) |
| Deploy command | `bash scripts/deploy-api.sh` |
| Non-production branch builds | معطّلة |
| Build variable | `NODE_VERSION` = `22` |

إذا توقف نشر بعد إنشاء مساحة KV وقبل ربطها، يحاول النشر التالي إنشاءها مرة ثانية ويفشل بالرسالة «a namespace with this account ID and title already exists». السكربت يتجنب ذلك: يجد المساحات الموجودة باسمها (`naf-sheets-auth-kv` و`naf-sheets-settings`) ويضع معرّفاتها في نسخة مؤقتة من الإعداد أثناء البناء فقط (`scripts/resolve-kv.mjs`)، فلا تدخل المستودع.

`npx wrangler deploy` وحده من الجذر يفشل بالرسالة «application detection logic has been run in the root of a workspace»، لأن الجذر فيه أكثر من تطبيق. السكربت يمرّر `--config apps/api/wrangler.toml`.

إن فشل إنشاء الموارد أو تطبيق المخطط بسبب الصلاحية، فرمز البناء الذي أنشأته Cloudflare ينقصه إذن. أضف إليه **D1: Edit** و**Workers KV Storage: Edit** و**Workers R2 Storage: Edit** و**Queues: Edit**.

## 5. الواجهة والنطاق

Worker واحد يخدم كل شيء، فلا يوجد مشروع Pages:

| الطلب | من يجيبه |
|---|---|
| `/api/*` و`/auth/*` و`/webhooks/*` و`/health` | كود الخادم |
| ملف من الواجهة (`/assets/…`) | ملفات الواجهة المبنية (`apps/web/dist`) |
| أي مسار آخر (`/` و`/workbooks/…` و`/denied`) | `index.html` من الواجهة، ثم تفتح الواجهة الشاشة المطلوبة |

الواجهة والخادم يُنشران معاً في كل نشر، فلا تعمل واجهة جديدة مع خادم قديم.

**النطاق:** `routes` في `wrangler.toml` تجعل `sheets.naflaw.sa` نطاقاً مخصصاً للـ Worker (`custom_domain = true`)، وCloudflare ينشئ سجل DNS والشهادة عند النشر. إن رفض النشر بسبب سجل DNS موجود مسبقاً للاسم `sheets`، فاحذف ذلك السجل من **DNS ← Records** ثم أعد النشر. لا يُحذف شيء دون موافقتك.

## 6. التسجيل لدى الأنظمة الخارجية

| النظام | ما يُسجّل |
|---|---|
| naf-id (لوحة الإدارة) | المنصة باسم `PLATFORM_ID`، وعنوان العودة `https://sheets.naflaw.sa/auth/callback`، وعنوان الخروج الخلفي `https://sheets.naflaw.sa/auth/backchannel-logout` |
| تطبيق Basecamp (launchpad.37signals.com/integrations) | Redirect URI: `https://sheets.naflaw.sa/auth/basecamp/callback` |
| Google Cloud (OAuth client من نوع Web) | Authorized redirect URI: `https://sheets.naflaw.sa/auth/google/callback`؛ ونطاق القراءة `spreadsheets.readonly` |

## 7. التحقق بعد أول نشر

1. `https://sheets.naflaw.sa/health` يعيد `{"ok":true}`.
2. فتح `https://sheets.naflaw.sa/` يحوّل إلى تسجيل الدخول في naf-id، ثم يعود إلى شاشة الملفات.
3. كل من يدخل أول مرة يُضاف عضواً بدور `viewer`، ولا شاشة في المنصة ترقّي أول مسؤول. بعد أول دخول لك نفّذ مرة واحدة (`apps/api/OPEN_QUESTIONS.md` البند 17):

   من **Storage & Databases ← D1 ← naf-sheets ← Console**:

   ```sql
   UPDATE members SET role = 'admin' WHERE email = '<بريدك>';
   ```

4. إنشاء ملف فارغ وتحريره ثم إعادة تحميل الصفحة: يبقى التعديل محفوظاً.
5. في الإعدادات: ربط حساب Basecamp، ثم ربط حساب الخدمة من شاشة المسؤول.

اعتماد المراحل (§15) لا يتم بهذه الخطوات. يحتاج اختبار Basecamp الحي (`spike/basecamp/README.md`) وملف Google Sheets حقيقياً.

## 8. ملاحظات

- **`naf-auth`** يُجلب أثناء التثبيت من GitHub بالوسم `v3.4.0`، والمستودع عام. `package-lock.json` يسجّل عنوانه بصيغة `git+ssh`. إن فشل التثبيت على Cloudflare بسبب SSH فهذه هي العلة، وتُعالج في المستودع لا في اللوحة.
- **الجدولة:** المطابقة كل 15 دقيقة والنسخ الاحتياطي اليومي (`[triggers]` في `wrangler.toml`) يعملان تلقائياً بعد النشر.
- **الخطة:** الخادم يستخدم Queues وDurable Objects وCron، وخطة الحساب المدفوعة (Workers Paid) تشملها.
- **الحجم:** كود الخادم حوالي 2.4 ميغابايت مضغوطاً (`wrangler deploy --dry-run`)، وحد الخطة المدفوعة 10. ملفات الواجهة (85 ملفاً، أكبرها 8.4 ميغابايت) تُرفع منفصلة عنه، وحد الملف الواحد 25 ميغابايت.
