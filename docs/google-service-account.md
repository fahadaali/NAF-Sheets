# إعداد حساب خدمة Google للمحطة

المحطة تقرأ ملفات Google Sheets المربوطة وتكتب فيها بـ **حساب خدمة** (Service Account): حساب آلي له بريد خاص، يُشارَك معه كل ملف كمحرّر. لا يحتاج أحد أن يسجّل دخول Google في المنصة.

> **المفتاح سرّ.** لا يُرسَل في المحادثة ولا يُحفظ في المستودع. يوضع فقط في Cloudflare كسرّ (الخطوة 5).

## 1. إنشاء المشروع

1. افتح <https://console.cloud.google.com> بحساب Google الخاص بناف.
2. من أعلى الصفحة: قائمة المشاريع ← **New Project**.
3. الاسم: `naf-sheets-station` ← **Create**، ثم تأكد أنه المشروع المختار في أعلى الصفحة.

## 2. تفعيل الواجهتين

من **APIs & Services ← Library**، ابحث عن كل واحدة واضغط **Enable**:

- **Google Sheets API** — قراءة الخلايا وكتابتها.
- **Google Drive API** — إشعار المنصة فور تعديل الملف.

## 3. إنشاء حساب الخدمة

1. **IAM & Admin ← Service Accounts ← Create service account**.
2. الاسم: `naf-sync` ← **Create and continue**.
3. خطوة الصلاحيات (Grant this service account access to project): **اتركها فارغة** ← **Continue** ← **Done**.
   لا يحتاج أي دور في المشروع؛ صلاحيته على الملفات تأتي من المشاركة (الخطوة 6).
4. انسخ بريده، وشكله: `naf-sync@naf-sheets-station.iam.gserviceaccount.com`. **هذا البريد ليس سرّاً** — أرسله لـ Claude.

## 4. إنشاء المفتاح

1. افتح حساب الخدمة ← تبويب **Keys** ← **Add key ← Create new key** ← **JSON** ← **Create**.
2. يُنزَّل ملف `.json` على جهازك. احتفظ به مؤقتاً للخطوة 5 ثم احذفه من جهازك.

إن ظهرت رسالة أن إنشاء المفاتيح ممنوع (`iam.disableServiceAccountKeyCreation`)، فالحساب تحت سياسة مؤسسة: أخبر Claude ولا تغيّر السياسة قبل الاتفاق على البديل.

## 5. وضع المفتاح في Cloudflare

من جذر المستودع، والصق **محتوى ملف JSON كاملاً** عند الطلب:

```bash
cd apps/api && npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
```

أو من لوحة Cloudflare: Worker `naf-sheets` ← **Settings ← Variables and Secrets ← Add** ← النوع **Secret** ← الاسم `GOOGLE_SERVICE_ACCOUNT_KEY`.

بعدها احذف ملف JSON من جهازك.

## 6. مشاركة الملف

في كل ملف يُربط: **Share** ← بريد حساب الخدمة ← **Editor** ← ألغِ «Notify people» ← **Share**.

صلاحية المحرّر لازمة لأن المنصة تكتب في الملف: تعديلات Basecamp، وتصحيح عنوان المهمة الرئيسية المكرر، وعلامات الصفوف.
