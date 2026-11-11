# ربط المنصة بـ Cloudflare

> **الحالة:** لم يُنشر شيء بعد. هذا الملف يصف الخطوات، ولم تُجرَّب على حساب Cloudflare حقيقي.
> **المرجع:** المواصفات §4 «الاستضافة: Cloudflare Pages (الواجهة) + Workers (API) على نطاق فرعي من `naflaw.sa`».
> **الإعدادات:** `apps/api/wrangler.toml` (الخادم)، و`apps/web` (الواجهة).

## 0. الفروع

| الفرع | دوره |
|---|---|
| `main` | فرع الإنتاج: كل دفعة إليه تُنشر تلقائياً على Cloudflare |
| أي فرع آخر | فرع عمل؛ يُدمج في `main` بطلب دمج (Pull Request) بعد نجاح الاختبارات |

اجعل `main` الفرع الافتراضي في GitHub: **Settings → General → Default branch** ← `main`.

## 1. قبل البدء

1. يجب أن يكون النطاق `naflaw.sa` مُداراً في حساب Cloudflare نفسه (لازم لربط الواجهة والخادم على عنوان واحد، §5).
2. اختيار النطاق الفرعي للمنصة، مثل `sheets.naflaw.sa`، وهو غير مقرر بعد (المواصفات §17-4). في هذا الملف يُكتب `<HOST>` مكانه.
3. على جهازك: Node 22، ثم `npm ci` في جذر المستودع، ثم `npx wrangler login`.

## 2. إنشاء الموارد (مرة واحدة)

من مجلد `apps/api`:

```bash
npx wrangler d1 create naf-sheets
npx wrangler kv namespace create AUTH_KV
npx wrangler kv namespace create SETTINGS
npx wrangler r2 bucket create naf-sheets-snapshots
npx wrangler r2 bucket create naf-sheets-attachments
npx wrangler r2 bucket create naf-sheets-backups
npx wrangler queues create bc-outbound
npx wrangler queues create bc-outbound-dlq
npx wrangler queues create bc-inbound
npx wrangler queues create bc-inbound-dlq
```

ثم في `apps/api/wrangler.toml` استبدل كل `REPLACE_WITH_*`:

| الحقل | القيمة |
|---|---|
| `database_id` | المعرّف الذي طبعه `d1 create` |
| `AUTH_KV` و`SETTINGS` ← `id` | المعرّفان اللذان طبعهما `kv namespace create` |
| `PLATFORM_ID` | اسم المنصة كما سُجّل في لوحة naf-id، حرفاً بحرف (حساس لحالة الأحرف) |
| `BASECAMP_ACCOUNT_ID` | رقم حساب ناف في Basecamp |
| `GOOGLE_CLIENT_ID` | معرّف تطبيق Google OAuth (ليس سرّاً) |
| `PUBLIC_API_ORIGIN` | `https://<HOST>` |

هذه القيم ليست أسراراً، فتُرفع في المستودع. ارفعها إلى `main` بطلب دمج: النشر التلقائي يفشل ما دام فيها `REPLACE_WITH_*`.

## 3. الأسرار (لا تُكتب في أي ملف)

من `apps/api`، واحداً واحداً، ويطلب كل أمر القيمة منك:

```bash
npx wrangler secret put AUTH_CLIENT_SECRET       # من لوحة naf-id
npx wrangler secret put TOKEN_ENCRYPTION_KEY     # 32 بايتاً عشوائية بترميز base64: openssl rand -base64 32
npx wrangler secret put BASECAMP_CLIENT_ID
npx wrangler secret put BASECAMP_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

لا تغيّر `TOKEN_ENCRYPTION_KEY` بعد أول استخدام: تغييره يُبطل رموز Basecamp وGoogle المحفوظة، فيعيد كل شخص الربط.

قد يرفض `secret put` قبل أول نشر للخادم. إن حدث ذلك فأكمل §4 أولاً، ثم عد إلى هنا.

## 4. الخادم: Worker مربوط بـ GitHub

في لوحة Cloudflare: **Workers & Pages → Create → Import a repository** ← اختر `fahadaali/NAF-Sheets`.

| الإعداد | القيمة |
|---|---|
| Project name | `naf-sheets-api` (يجب أن يطابق `name` في `wrangler.toml`) |
| Production branch | `main` |
| Root directory | `/` (جذر المستودع: الخادم يحتاج حزم `packages/*`) |
| Build command | فارغ |
| Deploy command | `npx wrangler d1 migrations apply naf-sheets --remote --config apps/api/wrangler.toml && npx wrangler deploy --config apps/api/wrangler.toml` |
| Non-production branch builds | معطّلة |
| Environment variable (Build) | `NODE_VERSION` = `22` |

أمر النشر يطبّق هجرات D1 الجديدة (`migrations/`، وهي إضافية فقط) ثم ينشر. إن فشل تطبيق الهجرات بسبب الصلاحية، فأضف صلاحية **D1: Edit** إلى رمز البناء الذي أنشأته Cloudflare، أو طبّقها مرة من جهازك:

```bash
cd apps/api && npx wrangler d1 migrations apply naf-sheets --remote
```

## 5. الواجهة: Pages مربوطة بـ GitHub

**Workers & Pages → Create → Pages → Connect to Git** ← `fahadaali/NAF-Sheets`.

| الإعداد | القيمة |
|---|---|
| Project name | `naf-sheets` |
| Production branch | `main` |
| Framework preset | None |
| Root directory | `/` |
| Build command | `npm run build -w @naf-sheets/web` |
| Build output directory | `apps/web/dist` |
| Environment variable | `NODE_VERSION` = `22` |

لا يوجد `404.html`، فتعيد Pages `index.html` لكل مسار مثل `/workbooks/…` و`/denied`، وهذا ما تحتاجه الواجهة.

## 6. عنوان واحد للواجهة والخادم

الواجهة تنادي `/api` و`/auth` بمسارات نسبية، وجلسة الدخول ملف تعريف ارتباط على العنوان نفسه. لذلك يعمل الاثنان على `<HOST>` واحد:

1. **Pages ← Custom domains** ← أضف `<HOST>`.
2. في `apps/api/wrangler.toml` فعّل كتلة `routes` المعلّقة وضع `<HOST>` مكان `REPLACE_WITH_HOST`. ارفعها إلى `main` فيُعاد النشر:

```toml
routes = [
  { pattern = "<HOST>/api/*", zone_name = "naflaw.sa" },
  { pattern = "<HOST>/auth/*", zone_name = "naflaw.sa" },
  { pattern = "<HOST>/webhooks/*", zone_name = "naflaw.sa" },
  { pattern = "<HOST>/health", zone_name = "naflaw.sa" },
]
```

مسارات Worker على النطاق تسبق Pages، فتذهب هذه المسارات الأربعة إلى الخادم ويذهب الباقي إلى الواجهة.

## 7. التسجيل لدى الأنظمة الخارجية

| النظام | ما يُسجّل |
|---|---|
| naf-id (لوحة الإدارة) | المنصة باسم `PLATFORM_ID`، وعنوان العودة `https://<HOST>/auth/callback`، وعنوان الخروج الخلفي `https://<HOST>/auth/backchannel-logout` |
| تطبيق Basecamp (launchpad.37signals.com/integrations) | Redirect URI: `https://<HOST>/auth/basecamp/callback` |
| Google Cloud (OAuth client من نوع Web) | Authorized redirect URI: `https://<HOST>/auth/google/callback`؛ ونطاق القراءة `spreadsheets.readonly` |

## 8. التحقق بعد أول نشر

1. `https://<HOST>/health` يعيد `{"ok":true}`.
2. فتح `https://<HOST>/` يحوّل إلى تسجيل الدخول في naf-id، ثم يعود إلى شاشة الملفات.
3. كل من يدخل أول مرة يُضاف عضواً بدور `viewer`، ولا شاشة في المنصة ترقّي أول مسؤول. بعد أول دخول لك نفّذ مرة واحدة (`apps/api/OPEN_QUESTIONS.md` البند 17):

   ```bash
   cd apps/api && npx wrangler d1 execute naf-sheets --remote --command "UPDATE members SET role = 'admin' WHERE email = '<بريدك>'"
   ```

4. إنشاء ملف فارغ وتحريره ثم إعادة تحميل الصفحة: يبقى التعديل محفوظاً.
5. في الإعدادات: ربط حساب Basecamp، ثم ربط حساب الخدمة من شاشة المسؤول.

اعتماد المراحل (§15) لا يتم بهذه الخطوات. يحتاج اختبار Basecamp الحي (`spike/basecamp/README.md`) وملف Google Sheets حقيقياً.

## 9. ملاحظات

- **`naf-auth`** يُجلب أثناء التثبيت من GitHub بالوسم `v3.4.0`، والمستودع عام. `package-lock.json` يسجّل عنوانه بصيغة `git+ssh`. إن فشل التثبيت على Cloudflare بسبب SSH فهذه هي العلة، وتُعالج في المستودع لا في اللوحة.
- **معاينات Pages** للفروع الأخرى (عناوين `*.pages.dev`) لا يصلها الخادم، فتظهر الواجهة فقط.
- **الجدولة:** المطابقة كل 15 دقيقة والنسخ الاحتياطي اليومي (`[triggers]` في `wrangler.toml`) يعملان تلقائياً بعد النشر.
- **الخطة:** الخادم يستخدم Queues وDurable Objects وCron. تأكد أن خطة الحساب تسمح بها كلها، وخطة Workers Paid تشملها.
- **حجم الخادم:** حوالي 2.4 ميغابايت مضغوطاً (`wrangler deploy --dry-run`). حد الخطة المجانية 3 ميغابايت وحد المدفوعة 10.
