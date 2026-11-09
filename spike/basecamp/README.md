# عدّة الاختبار الحي لـ Basecamp — المرحلة 0

تجيب عن سؤال واحد تعجز الوثائق عن حسمه (المواصفات §9.3.6 و§15): **أيّ حدث Webhook يصل لكل تغيير يُجرى في واجهة Basecamp، وأيّ تغيير لا يصل عنه شيء؟** فالنتيجة تقرّر لكل حقل: هل تعتمد المزامنة الواردة على الـ Webhook أم على المطابقة الدورية؟

وتفحص معها أمرين يمسّان سلامة البيانات مباشرة:

- **الكتلة المُدارة** في وصف المهمة: هل تبقى كما أُرسلت بعد الحفظ في Basecamp؟ (§8.2)
- **`PUT /todos` بكل الحقول**: تغيير التاريخ وحده يُبقي المسؤولين والوصف؟ (السيناريو 9)

**لا تحذف العدّة شيئاً.** كل ما أنشأته مذكور في التقرير، وحذفه يدوي بعد اعتماد النتائج.

---

## ما يلزم قبل التشغيل

| المطلوب | من أين |
|---|---|
| **مشروع تجريبي** في Basecamp — لا مشروع حقيقي | يُنشأ يدوياً من Basecamp |
| رمز وصول (`BC_TOKEN`) لحساب عضو في المشروع التجريبي، ومعرّف الحساب (`BC_ACCOUNT_ID`) | تطبيق OAuth مسجّل في Launchpad (`launchpad.37signals.com/integrations`) |
| معرّف المشروع (`BC_PROJECT_ID`) ومعرّف شخص فيه (`BC_ASSIGNEE_ID`) | من رابط المشروع، ومن `GET /projects/{id}/people.json` |
| نشر المسجّل `recorder/` على Cloudflare بعنوان HTTPS | حساب Cloudflare — انظر أدناه |

## الخطوات

```bash
# ١) انشر المسجّل
cd recorder
npx wrangler kv namespace create naf-sheets-phase0-events   # ضع المعرّف في wrangler.toml
npx wrangler secret put RECORDER_SECRET                      # قيمة عشوائية طويلة
npx wrangler secret put READ_TOKEN                           # قيمة عشوائية أخرى
npx wrangler deploy                                          # يطبع عنوان المسجّل
cd ..

# ٢) اضبط المتغيّرات في الطرفية (لا تُكتب في ملف ولا تُلتزم)
export BC_TOKEN=… BC_ACCOUNT_ID=… BC_PROJECT_ID=… BC_ASSIGNEE_ID=…
export RECORDER_URL=https://naf-sheets-phase0-recorder.<الحساب>.workers.dev
export RECORDER_SECRET=… READ_TOKEN=…

# ٣) أنشئ عناصر الاختبار وافحص الأمرين الآليين
node live-test.mjs setup
node live-test.mjs check-block
node live-test.mjs check-put

# ٤) لكل خطوة يدوية: علامة أولاً، ثم التنفيذ في واجهة Basecamp، ثم انتظار دقيقة
node live-test.mjs mark "تغيير تاريخ استحقاق المهمة"
#    … نفّذ في Basecamp …
#    (أمر setup يطبع قائمة الخطوات السبع كاملة)

# ٥) اجمع الأحداث واكتب التقرير
node live-test.mjs events
node live-test.mjs report      # ← live-test-report.md
```

**علامةٌ قبل كل خطوة لا بعدها.** التقرير ينسب كل حدث إلى آخر علامة سبقته بحسب وقت إنشائه في Basecamp (`created_at`)، فخطوتان بلا علامة بينهما تختلط أحداثهما.

## الاختبارات

```bash
npm test
```

تشغّل العدّة كاملة على خادم Basecamp وهمي محلي يطبّق السلوك الموثّق (`PUT /todos` يمسح الحقل غير المُرسل)، ومعه المسجّل نفسه. وتتحقق أن كل طلب يحمل `User-Agent` الإلزامي، وأن أحداث المشاريع الأخرى تُتجاهل، وأن العدّة لا ترسل `DELETE` أبداً.
