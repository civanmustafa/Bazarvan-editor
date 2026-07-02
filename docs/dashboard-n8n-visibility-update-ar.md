# خطوات تحديث لوحة التحكم و n8n على Hostinger

هذا التحديث يضيف تحسينات لوحة التحكم، يوسع البحث والفلترة، يحذف خيارَي `shared` و `team` من `visibility`، ويجعل حالة المقالة قابلة للتعديل من داخل المحرر.

## 1. تحديث Supabase

افتح Supabase ثم SQL Editor وشغل ملف الهجرة التالي:

```text
supabase/migrations/20260702010000_limit_article_visibility_options.sql
```

ماذا يفعل الملف؟

- يحول أي مقالة قديمة لديها `visibility = shared` أو `visibility = team` إلى `public`.
- يجعل الخيارات المسموحة بعد ذلك فقط:
  - `private`
  - `public`

بعد هذا التحديث، عدل n8n حتى لا يرسل `shared` أو `team` في حقل `visibility`.

## 2. تحديث n8n

في عقدة إرسال المقالة إلى المحرر، استخدم أحد الخيارين فقط:

```json
{
  "visibility": "private"
}
```

أو:

```json
{
  "visibility": "public"
}
```

إذا لم ترسل `visibility`:

- عند تحديد مستخدمين للمقالة، سيجعلها النظام `private`.
- إذا لم تحدد مستخدمين، سيجعلها النظام `public`.

## 3. تحديث السيرفر Hostinger

ادخل إلى السيرفر عبر SSH ثم نفذ:

```bash
cd /path/to/editor
git pull origin main
npm ci
npm run build
pm2 restart bazarvan-editor --update-env
```

استبدل `/path/to/editor` بمسار مشروع المحرر على السيرفر.

## 4. التحقق بعد النشر

- افتح لوحة التحكم.
- تأكد أن بطاقة المقالة تعرض تاريخ الإنشاء.
- تأكد أن حقل `visibility` لا يعرض خيارات `shared` أو `team`.
- افتح مقالة من لوحة التحكم وجرب تغيير `status` من شريط عنوان المحرر.
- افتح تبويب المنافسين وتأكد أن خانات HTML لم تعد تظهر.

