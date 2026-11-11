# ربط المنصة بـ Cloudflare

> **الحالة:** لم يُنشر شيء بعد. هذا الملف يصف الخطوات، ولم تُجرَّب على حساب Cloudflare حقيقي.
> **المرجع:** المواصفات §4 «الاستضافة: Cloudflare Pages (الواجهة) + Workers (API) على نطاق فرعي من `naflaw.sa`».
> **الإعدادات:** `apps/api/wrangler.toml` و`scripts/deploy-api.sh` (الخادم)، و`apps/web` (الواجهة).

## 0. الفروع

| الفرع | دوره |
|---|---|
| `main` | فرع الإنتاج: كل دفعة إليه تُنشر تلقائياً على Cloudflare |
| أي فرع آخر | فرع عمل؛ يُدمج في `main` بطلب دمج (Pull Request) بعد نجاح الاختبارات |

اجعل `main` الفرع الافتراضي في GitHub: **Settings → General → Default branch** ← `main`.

## 1. قبل البدء

1. يجب أن يكون النطاق `naflaw.sa` مُداراً في حساب Cloudflare نفسه (لازم لربط الواجهة والخادم على عنوان واحد، §6).
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

## 4. الخادم: Worker مربوط بـ GitHub

في لوحة Cloudflare: **Workers & Pages → Create → Import a repository** ← اختر `fahadaali/NAF-Sheets`. إن كان المشروع موجوداً فعدّل إعداداته من **Settings ← Build**.

| الإعداد | القيمة |
|---|---|
| Project name | `naf-sheets` (يجب أن يطابق `name` في `wrangler.toml`) |
| Production branch | `main` |
| Root directory | `/` (جذر المستودع: الخادم يحتاج حزم `packages/*`) |
| Build command | فارغ (الخادم لا يحتاج بناء الواجهة) |
| Deploy command | `bash scripts/deploy-api.sh` |
| Non-production branch builds | معطّلة |
| Build variable | `NODE_VERSION` = `22` |

إذا توقف نشر بعد إنشاء مساحة KV وقبل ربطها، يحاول النشر التالي إنشاءها مرة ثانية ويفشل بالرسالة «a namespace with this account ID and title already exists». السكربت يتجنب ذلك: يجد المساحات الموجودة باسمها (`naf-sheets-auth-kv` و`naf-sheets-settings`) ويضع معرّفاتها في نسخة مؤقتة من الإعداد أثناء البناء فقط (`scripts/resolve-kv.mjs`)، فلا تدخل المستودع.

`npx wrangler deploy` وحده من الجذر يفشل بالرسالة «application detection logic has been run in the root of a workspace»، لأن الجذر فيه أكثر من تطبيق. السكربت يمرّر `--config apps/api/wrangler.toml`.

إن فشل إنشاء الموارد أو تطبيق المخطط بسبب الصلاحية، فرمز البناء الذي أنشأته Cloudflare ينقصه إذن. أضف إليه **D1: Edit** و**Workers KV Storage: Edit** و**Workers R2 Storage: Edit** و**Queues: Edit**.

## 5. الواجهة: Pages مربوطة بـ GitHub

**Workers & Pages → Create → Pages → Connect to Git** ← `fahadaali/NAF-Sheets`.

| الإعداد | القيمة |
|---|---|
| Project name | `naf-sheets-web` (اسم مختلف عن مشروع الخادم `naf-sheets`) |
| Production branch | `main` |
| Framework preset | None |
| Root directory | `/` |
| Build command | `npm run build -w @naf-sheets/web` |
| Build output directory | `apps/web/dist` |
| Environment variable | `NODE_VERSION` = `22` |

لا يوجد `404.html`، فتعيد Pages `index.html` لكل مسار مثل `/workbooks/…` و`/denied`، وهذا ما تحتاجه الواجهة.

## 6. عنوان واحد للواجهة والخادم

الواجهة تنادي `/api` و`/auth` بمسارات نسبية، وجلسة الدخول ملف تعريف ارتباط على العنوان نفسه. لذلك يعمل الاثنان على العنوان نفسه `sheets.naflaw.sa`:

1. **Pages ← Custom domains** ← أضف `sheets.naflaw.sa`.
2. مسارات الخادم مفعّلة في `apps/api/wrangler.toml`، ومعها `PUBLIC_API_ORIGIN = "https://sheets.naflaw.sa"`:

```toml
routes = [
  { pattern = "sheets.naflaw.sa/api/*", zone_name = "naflaw.sa" },
  { pattern = "sheets.naflaw.sa/auth/*", zone_name = "naflaw.sa" },
  { pattern = "sheets.naflaw.sa/webhooks/*", zone_name = "naflaw.sa" },
  { pattern = "sheets.naflaw.sa/health", zone_name = "naflaw.sa" },
]
```

مسارات Worker على النطاق تسبق Pages، فتذهب هذه المسارات الأربعة إلى الخادم ويذهب الباقي إلى الواجهة.

## 7. التسجيل لدى الأنظمة الخارجية

| النظام | ما يُسجّل |
|---|---|
| naf-id (لوحة الإدارة) | المنصة باسم `PLATFORM_ID`، وعنوان العودة `https://sheets.naflaw.sa/auth/callback`، وعنوان الخروج الخلفي `https://sheets.naflaw.sa/auth/backchannel-logout` |
| تطبيق Basecamp (launchpad.37signals.com/integrations) | Redirect URI: `https://sheets.naflaw.sa/auth/basecamp/callback` |
| Google Cloud (OAuth client من نوع Web) | Authorized redirect URI: `https://sheets.naflaw.sa/auth/google/callback`؛ ونطاق القراءة `spreadsheets.readonly` |

## 8. التحقق بعد أول نشر

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

## 9. ملاحظات

- **`naf-auth`** يُجلب أثناء التثبيت من GitHub بالوسم `v3.4.0`، والمستودع عام. `package-lock.json` يسجّل عنوانه بصيغة `git+ssh`. إن فشل التثبيت على Cloudflare بسبب SSH فهذه هي العلة، وتُعالج في المستودع لا في اللوحة.
- **معاينات Pages** للفروع الأخرى (عناوين `*.pages.dev`) لا يصلها الخادم، فتظهر الواجهة فقط.
- **الجدولة:** المطابقة كل 15 دقيقة والنسخ الاحتياطي اليومي (`[triggers]` في `wrangler.toml`) يعملان تلقائياً بعد النشر.
- **الخطة:** الخادم يستخدم Queues وDurable Objects وCron، وخطة الحساب المدفوعة (Workers Paid) تشملها.
- **حجم الخادم:** حوالي 2.4 ميغابايت مضغوطاً (`wrangler deploy --dry-run`)، وحد الخطة المدفوعة 10.
