# مسار النشر المعتمد على هوستينجر

استخدم مسار الخادم التالي عند نشر محرر بازارفان:

`/var/www/bazarvan-editor`

## ترحيلات التحليل الخارجي

قبل أول نشر لعامل التحليل الخارجي، نفّذ الترحيلات التالية بالترتيب داخل **Supabase SQL Editor**:

1. `supabase/migrations/20260710000000_external_analysis_foundation.sql`
2. `supabase/migrations/20260710010000_external_analysis_worker_queue.sql`
3. `supabase/migrations/20260710020000_external_semantic_generation.sql`
4. `supabase/migrations/20260710030000_external_engineering_commands.sql`
5. `supabase/migrations/20260711000000_external_analysis_job_controls.sql`
6. `supabase/migrations/20260711010000_dashboard_filtered_pagination.sql`
7. `supabase/migrations/20260711020000_external_analysis_scheduler_settings.sql`
8. `supabase/migrations/20260711030000_external_analysis_command_preferences.sql`
9. `supabase/migrations/20260712000000_external_analysis_independent_batches.sql`
10. `supabase/migrations/20260713000000_phase_0_1_security_hardening.sql`
11. `supabase/migrations/20260713010000_phase_2_3_access_and_atomic_article_save.sql`

نفّذ الترحيلين 10 و11 قبل نشر إصدار الويب والخادم المقابل لهما. تعتمد واجهة حفظ المقالة الجديدة على الدالة `save_article_snapshot` التي يضيفها الترحيل 11.

## ترحيلات كتابة المقالة المنظمة

قبل نشر نظام كتابة المقالة المنظمة، نفّذ الترحيلات التالية بالترتيب:

1. `supabase/migrations/20260722000000_content_writing_sessions.sql` — يمكن تخطيه فقط إذا سبق تنفيذه بنجاح.
2. `supabase/migrations/20260722010000_structured_content_writing.sql`
3. `supabase/migrations/20260722020000_content_writing_application.sql`
4. `supabase/migrations/20260722030000_content_writing_external_reporting.sql`
5. `supabase/migrations/20260722040000_content_writing_quality_guards.sql`
6. `supabase/migrations/20260723000000_content_writing_quality_policy.sql`
7. `supabase/migrations/20260723010000_content_writing_knowledge_workflow.sql`

تضيف هذه الترحيلات جلسات دائمة، وخطوات قابلة للاستئناف، وإدراج المقالة بعد المراجعة، وتسجيل النتائج الخارجية، ومنع تشغيل أكثر من جلسة نشطة، وتقارير جودة حتمية ذات إصدارات، وفهرسة معرفة المنافسين، وتدقيق التغطية، وإصلاح الأقسام المستهدفة.

يجب تنفيذ الترحيلات السبعة كلها قبل نشر إصدار الخادم المقابل. إذا كنت قد نفذت الترحيلات الستة السابقة، فلا تعِد تنفيذها؛ نفّذ الترحيل السابع الجديد فقط. يعيد فحص الجاهزية `/readyz` حالة HTTP 503 إذا لم يكن مخطط قاعدة البيانات المطلوب لنظام كتابة المقالة متوفرًا.

## مفاتيح OpenAI وGemini المدفوعة التي يديرها المسؤول

قبل تفعيل المفاتيح المدفوعة التي يدخلها المسؤول من الإعدادات:

1. نفّذ `supabase/migrations/20260722050000_admin_ai_provider_secrets.sql` داخل **Supabase SQL Editor**.
2. أنشئ مفتاح تشفير واحدًا على الخادم بالأمر `openssl rand -base64 32`.
3. أضف القيمة الناتجة باسم `AI_SETTINGS_ENCRYPTION_KEY` داخل `/var/www/bazarvan-editor/.env.production`.
4. لا تحذف القيم الحالية لـ `OPENAI_API_KEY` و`GEMINI_PAID_API_KEYS`؛ فهي تبقى مفاتيح هوستينجر الاحتياطية عند تعطيل المفتاح الذي أدخله المسؤول.

تُشفّر مفاتيح المسؤول الخام بخوارزمية AES-256-GCM قبل تخزينها، ولا تعيدها واجهة الإعدادات، ولا تستطيع أدوار Supabase من نوع `anon` أو `authenticated` قراءتها.

فقدان `AI_SETTINGS_ENCRYPTION_KEY` أو تغييره يجعل مفاتيح المسؤول المخزنة سابقًا غير قابلة للقراءة. احتفظ به داخل بيئة الخادم فقط، وأنشئ له نسخة احتياطية آمنة.

## أوامر النشر

بعد تنفيذ ترحيلات Supabase المطلوبة، اتصل بالخادم عبر SSH ونفّذ:

```bash
cd /var/www/bazarvan-editor
git pull --ff-only origin main
set -a
source .env.production
set +a
npm ci
npm run build
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
curl -fsS https://smarteditor.bazarvan.com/healthz
curl -fsS https://smarteditor.bazarvan.com/readyz
```

معنى الأوامر باختصار:

- `git pull --ff-only origin main`: يسحب آخر إصدار مرفوع إلى GitHub من دون إنشاء دمج تلقائي.
- `source .env.production`: يحمّل متغيرات بيئة الإنتاج أثناء البناء وإعادة التشغيل.
- `npm ci`: يثبت الاعتماديات طبقًا لملف القفل.
- `npm run build`: يبني الواجهة والخادم والعوامل وينفّذ فحوص الإصدار.
- `pm2 startOrReload ... --update-env`: يشغّل العمليات الجديدة أو يعيد تحميل القائمة الحالية مع متغيرات البيئة المحدثة.
- `pm2 save`: يحفظ قائمة العمليات لكي تعود بعد إعادة تشغيل الخادم.
- `/healthz`: يتحقق من أن خادم الويب يعمل.
- `/readyz`: يتحقق أيضًا من بناء الإنتاج، ومخططات Supabase المطلوبة، ومفتاح التشفير.

## ملاحظات وتشخيص المشكلات

- يشغّل PM2 خادم الويب وجميع العوامل المضبوطة، ومنها `bazarvan-content-writing-worker`، من `/var/www/bazarvan-editor`. هذا هو المسار المعتمد.
- لا تستخدم `/var/www/bazarvan-smarteditor` في تعليمات النشر المستقبلية إلا إذا أُعيد ضبط PM2 عمدًا للعمل منه.
- إذا لم تكن حالة النشر واضحة، اعرض جميع العمليات بالأمر `pm2 status`.
- لفحص خادم الويب استخدم `pm2 describe bazarvan-editor`.
- لفحص عامل كتابة المقالة استخدم `pm2 describe bazarvan-content-writing-worker`.
- عند فشل `/readyz` لا تعتبر النشر مكتملًا؛ راجع الترحيلات ومتغيرات البيئة وسجل العملية في PM2.
