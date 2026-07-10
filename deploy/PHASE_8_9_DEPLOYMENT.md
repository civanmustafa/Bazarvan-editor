# خطوات تطبيق تحديثات Bazarvan Editor

هذا التحديث يحول التطبيق إلى Web App بروابط مباشرة، يجعل Supabase مصدر الحقيقة، ويضيف صفحات الأدمن والإعدادات والتقارير وn8n والصلاحيات.

## 1. تطبيق migrations على Supabase

نفذ ملفات SQL داخل `supabase/migrations` بالترتيب الزمني من الأقدم إلى الأحدث، أو استخدم Supabase CLI إن كان مربوطا بالمشروع.

الملفات الجديدة المهمة في هذه الدفعة:

```text
supabase/migrations/20260703020000_phase_4_5_settings_activity_sessions.sql
supabase/migrations/20260703030000_phase_7_route_permissions.sql
```

إذا كنت تستخدم Supabase Dashboard:

1. افتح Supabase Project.
2. ادخل إلى SQL Editor.
3. انسخ محتوى كل migration بالترتيب.
4. اضغط Run لكل ملف.

إذا كنت تستخدم Supabase CLI:

```bash
supabase db push
```

## 2. ضبط Environment Variables على Hostinger

أضف القيم التالية في بيئة السيرفر/PM2:

```bash
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
N8N_INGEST_TOKEN=YOUR_PRIVATE_N8N_TOKEN
EDITOR_PUBLIC_URL=https://editor.example.com
```

اختياري حسب استخدامك:

```bash
GEMINI_API_KEYS=...
GEMINI_PAID_API_KEYS=...
OPENAI_API_KEY=...
```

لا تضع مفاتيح `SERVICE_ROLE` أو مفاتيح AI داخل المتصفح أو داخل `.env` العام للواجهة.

## 3. تحديث إعدادات Online بعد الدخول كأدمن

بعد النشر افتح:

```text
/settings/system
/settings/ai
/settings/n8n
/settings/roles
```

وتأكد من:

1. `publicEditorUrl` يطابق الدومين الحقيقي.
2. إعدادات n8n مفعلة.
3. `defaultVisibility` و `defaultAccessRole` مناسبان لسير عملك.
4. إعدادات الحذف التلقائي من السلة مناسبة.

## 4. نشر الكود على Hostinger

على السيرفر داخل المسار المعتمد للمشروع:

```bash
cd /var/www/bazarvan-editor
git pull origin main
set -a
source .env.server
set +a
npm run build
pm2 restart bazarvan-editor --update-env
pm2 save
```

ثم تحقق من Nginx/HTTPS وأن كل الروابط ترجع إلى التطبيق:

```text
/dashboard
/admin
/admin/articles
/admin/n8n
/admin/reports/daily/2026-07-03
/settings
/settings/ai
/editor/:articleId
```

## 5. ضبط n8n

أرسل المقالات إلى:

```text
POST https://editor.example.com/api/n8n/articles
```

Headers:

```text
Content-Type: application/json
X-N8N-Token: YOUR_PRIVATE_N8N_TOKEN
```

الاستجابة الناجحة ترجع:

```json
{
  "success": true,
  "articleId": "ARTICLE_ID",
  "articleUrl": "https://editor.example.com/editor/ARTICLE_ID",
  "adminUrl": "https://editor.example.com/admin/articles/ARTICLE_ID",
  "status": "created"
}
```

## 6. اختبارات بعد النشر

1. افتح `/admin/articles` كأدمن وتأكد من ظهور المقالات.
2. افتح رابط مقالة مباشرة `/editor/:articleId`.
3. جرّب مستخدما عاديا: يجب ألا يرى روابط الأدمن.
4. جرّب مقالة محجوزة: يجب ألا تظهر لباقي المستخدمين.
5. أرسل طلب n8n تجريبي وتأكد من رجوع `articleUrl` و `adminUrl`.
6. افتح `/admin/reports/daily/YYYY-MM-DD` وتأكد من ظهور تقرير اليوم.
