# إعدادات المقالة اليدوية الجديدة

عند إنشاء مقالة جديدة من داخل المحرر، يتم ضبط القيم الافتراضية كالتالي:

```text
status: draft / مسودة
visibility: public / عام
accessRole: editor / تعديل
visibleToEmailsCsv: بريد المستخدم الذي أنشأ المقالة
assigned_to: المستخدم الذي أنشأ المقالة
```

## خطوة مطلوبة في Supabase

بعد رفع التحديث إلى GitHub وتحديث السيرفر، افتح Supabase ثم SQL Editor وشغل الملف:

```text
supabase/migrations/20260703010000_manual_article_public_defaults.sql
```

هذا الملف يسمح للمستخدم العادي بإنشاء مقالة يدوية بحالة `public` بشرط أن تكون المقالة مملوكة له ومخصصة له.

## تحديث Hostinger

نفذ:

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
