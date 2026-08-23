# تشغيل Supabase الذاتية على خادم Hostinger الحالي

هذه الحزمة تنفذ تشغيل Supabase الذاتي على VPS الحالي. بعد اعتماد القطع النهائي أزيلت فقط عمليات محرر PM2 القديمة التي كانت تتصل بـSupabase Cloud؛ بقيت جميع الخدمات الأخرى والحاويات القائمة دون تغيير.

نُشرت البيئة الذاتية فعليًا في 2026-08-18 وأصبح النطاق الرئيسي يستخدمها. راجع `DEPLOYMENT_STATUS.md` و`STAGING_RUNBOOK.md` للحالة المقاسة. سكربتات هذا المجلد مخصصة لإعادة إنتاج الإعداد أو فحصه، ولا تُشغّل على المجلد القديم أو على خدمات أخرى.

## التصميم

- المصدر الرسمي المثبت: `self-hosted/v0.8.0` من مستودع Supabase.
- الخدمات التي ستعمل فقط: `db`, `auth`, `rest`, `realtime`, `api-gw`.
- الخدمات غير المشغلة: Studio وStorage وimgproxy وEdge Runtime وSupavisor وLogs & Analytics وpostgres-meta.
- منفذ API التجريبي: `127.0.0.1:18000`، وليس منفذًا عامًا.
- PostgreSQL يبقى داخل شبكة Docker ولا ينشر منفذًا على المضيف.
- الحد الأعلى النظري لذاكرة الحاويات الخمس: نحو 2.2 GB.
- الحاويات الخمس الفعلية تستخدم الأسماء الرسمية: `supabase-db` و`supabase-auth` و`supabase-rest` و`realtime-dev.supabase-realtime` و`supabase-envoy`.

الإصدار `v0.8.0` هو إصدار self-hosted الرسمي بتاريخ 2026-08-11 ويستخدم Envoy بوابة API الافتراضية.

## قواعد إلزامية

- لا تستخدم `run.sh start` لأنه يشغّل الخدمات غير المطلوبة.
- لا تستخدم `run.sh stop` أو `docker compose down` أو `reset.sh`.
- لا تستخدم أوامر Docker عامة مثل `docker system prune`.
- استخدم السكربتات الموجودة هنا فقط؛ سكربت الرجوع يوقف الحاويات الخمس الجديدة ولا يحذف volumes.
- لا تغيّر متغيرات التطبيق الإنتاجية في هذه المرحلة.
- لا تفتح المنفذ `18000` أو PostgreSQL للعامة.

## التحضير

من نسخة المشروع الموجودة في `/var/www/bazarvan-editor-staging`:

```bash
cd /var/www/bazarvan-editor-staging/deploy/hostinger-supabase
sudo ./prepare-minimal.sh /opt/bazarvan-supabase
```

يقوم التحضير بما يلي فقط:

1. يجلب الإصدار الرسمي المثبت.
2. ينشئ `/opt/bazarvan-supabase` إذا لم يكن موجودًا.
3. يولد مفاتيح جديدة داخل `/opt/bazarvan-supabase/.env` بصلاحية `0600`.
4. يضيف override للمنافذ وحدود الموارد.
5. يتحقق من تكوين Compose.

لا يسحب التحضير صور الحاويات ولا يشغل أي حاوية.

## فحص ما قبل التشغيل

```bash
cd /opt/bazarvan-supabase
./preflight.sh
```

يفشل الفحص تلقائيًا إذا:

- كان المنفذ المحلي 18000 مستخدمًا.
- كانت الذاكرة المتاحة أقل من 3 GB.
- كانت المساحة المتاحة أقل من 20 GB.
- كانت أي عملية PM2 الحالية غير `online`.
- وُجدت حاويات سابقة تحمل أسماء الحزمة الجديدة.
- لم ينجح تحليل ملفات Compose.

## تشغيل البيئة المحلية التجريبية

بعد مراجعة نتيجة الفحص:

```bash
cd /opt/bazarvan-supabase
BAZARVAN_SUPABASE_APPROVE_START=1 ./start-minimal.sh
```

يشغّل السكربت الخدمات واحدة تلو الأخرى. بعد كل خدمة يتحقق من أن جميع حاويات Docker السابقة ما زالت تعمل، وأن عمليات PM2 بقيت `online`، وأن الذاكرة المتاحة لم تنخفض عن 1.5 GB. عند فشل أي بوابة، يوقف الخدمات الجديدة التي بدأها فقط.

## التحقق

```bash
cd /opt/bazarvan-supabase
./verify-minimal.sh
```

يتحقق السكربت من صحة الحاويات ومساري Auth وPostgREST ومن بقاء PM2 سليمًا، دون طباعة أي مفتاح.

## الرجوع الآمن

```bash
cd /opt/bazarvan-supabase
BAZARVAN_SUPABASE_APPROVE_STOP=1 ./stop-minimal.sh
```

هذا الأمر يوقف الحاويات الجديدة فقط. لا يحذف البيانات ولا الشبكة ولا أي خدمة كانت موجودة قبل المشروع.

## الخطوات التالية بعد نجاح التشغيل

1. مراقبة الذاكرة والمعالج وسجلات الحاويات مدة كافية.
2. تطبيق ترحيلات المشروع على قاعدة تجريبية فارغة باستخدام `apply-project-migrations.sh`، ثم تشغيل `verify-project-schema.sh`.
3. اختبار Auth وRPC وRLS وRealtime.
4. التحقق من المسار الحالي `https://smarteditor.bazarvan.com/supabase/` عبر HTTPS وWebSocket؛ وهو منشور من خلال Nginx Proxy Manager الموجود.
5. في البداية النظيفة لا يُؤخذ dump من Supabase Cloud ولا تُستعاد بيانات المقالات أو العملاء؛ يقتصر النسخ الاحتياطي على إعدادات البنية عند الحاجة.
6. عدم تغيير إنتاج التطبيق قبل اكتمال بروفتين ناجحتين وموافقة صريحة.

## البداية النظيفة

عند اعتماد بدء جديد دون بيانات Cloud، تبقى الجداول والمخطط فارغة ولا تُستورد المقالات أو سجلات العملاء أو الطوابير القديمة. يُستخدم المسار العام التالي على النطاق الحالي:

```text
https://smarteditor.bazarvan.com/supabase/
```

يجب إنشاء حساب إداري جديد قبل تحويل التطبيق، ولا تُفعّل التسجيلات العامة أو تغيّر متغيرات إنتاج التطبيق قبل اختبار Auth وREST وRealtime.

بعد نجاح البنية الأساسية، يُستخدم [دليل النسخة العامة](./STAGING_RUNBOOK.md) لتشغيل نسخة التطبيق الذاتية على نفس VPS. النسخة في `/var/www/bazarvan-editor-staging` هي العامة حاليًا؛ لا تُستخدم `pm2 restart all` ولا يُعاد تشغيل `/var/www/bazarvan-editor`.

المراجع الرسمية:

- <https://supabase.com/docs/guides/self-hosting/docker>
- <https://github.com/supabase/supabase/releases/tag/self-hosted/v0.8.0>
