# المرحلة 8 و9: تجهيز API الذكاء الاصطناعي والنشر على Hostinger VPS

هذا الدليل مخصص لتشغيل المحرر على صب دومين خاص، مع إبقاء مفاتيح Gemini وOpenAI على السيرفر فقط.

## ماذا تغير في المشروع؟

- تم إضافة خادم إنتاج Node/Express في `server/server.ts`.
- الخادم يشغل الواجهة المبنية داخل `dist`.
- الخادم يستقبل:
  - `/api/gemini`
  - `/api/chatgpt`
- المتصفح لم يعد يرسل مفاتيح Gemini/OpenAI.
- المفاتيح تقرأ فقط من متغيرات البيئة على السيرفر:
  - `GEMINI_API_KEYS`
  - `OPENAI_API_KEY` أو `OPENAI_API_KEYS`
- تم إضافة فحص صحة بسيط:
  - `/healthz`

## تنبيه أمان مهم

بما أن مفاتيح Gemini ظهرت سابقا خارج السيرفر، أنصح قبل الإنتاج أن تنشئ مفاتيح Gemini جديدة من Google AI Studio وتعطل القديمة. في الإنتاج لا تضع أي مفتاح ذكاء اصطناعي داخل ملفات تبدأ بـ `VITE_`.

## الملفات الجديدة المهمة

- `server/server.ts`: خادم الإنتاج.
- `scripts/build-server.mjs`: يبني خادم الإنتاج إلى `server-dist/server.mjs`.
- `ecosystem.config.cjs`: إعداد PM2.
- `deploy/env.server.example`: مثال ملف البيئة على السيرفر.
- `deploy/nginx/bazarvan-editor.conf`: مثال إعداد Nginx.
- `.env.production.example`: مثال قيم Supabase العامة للواجهة.

## الخطوة 1: اختيار الصب دومين

اختر صب دومين غير مستخدم، مثلا:

```text
editor.yourdomain.com
```

إذا كان لديك صب دومين موجود لخدمة أخرى، لا تستخدمه. سننشئ ملف Nginx جديد للمحرر فقط.

## الخطوة 2: إعداد DNS في Hostinger

من لوحة Hostinger:

1. افتح DNS Zone للدومين.
2. أضف Record جديد:

```text
Type: A
Name: editor
Value: IP السيرفر VPS
TTL: Default
```

إذا كان الصب دومين هو `editor.yourdomain.com` فالاسم يكون غالبا `editor`.

## الخطوة 3: الدخول إلى السيرفر

من جهازك افتح Terminal أو PowerShell:

```bash
ssh root@YOUR_SERVER_IP
```

استبدل `YOUR_SERVER_IP` برقم IP الخاص بالسيرفر.

## الخطوة 4: تثبيت المتطلبات

على Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx curl
```

تثبيت Node.js. استخدم Node 20 أو أحدث:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

تثبيت PM2:

```bash
sudo npm install -g pm2
```

تأكد من النسخ:

```bash
node -v
npm -v
pm2 -v
nginx -v
git --version
```

## الخطوة 5: رفع المشروع من GitHub إلى السيرفر

اختر مكان المشروع:

```bash
sudo mkdir -p /var/www
cd /var/www
sudo git clone YOUR_GITHUB_REPO_URL bazarvan-editor
sudo chown -R $USER:$USER /var/www/bazarvan-editor
cd /var/www/bazarvan-editor
```

استبدل `YOUR_GITHUB_REPO_URL` برابط مستودع GitHub.

## الخطوة 6: إنشاء ملف البيئة على السيرفر

انسخ المثال:

```bash
cp deploy/env.server.example .env.server
nano .env.server
```

ضع القيم الحقيقية:

```text
NODE_ENV=production
PORT=8080

VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key

GEMINI_API_KEYS=ضع_مفاتيح_Gemini_الجديدة_هنا_مفصولة_بفواصل
OPENAI_API_KEY=ضع_مفتاح_OpenAI_الجديد_هنا
```

مهم: `VITE_SUPABASE_URL` يجب أن يكون رابط مشروع Supabase الأساسي، وليس رابط `/rest/v1`.

للحفظ داخل `nano`:

```text
Ctrl + O
Enter
Ctrl + X
```

## الخطوة 7: بناء المشروع وتشغيله عبر PM2

نفذ:

```bash
set -a
source .env.server
set +a
npm ci
npm run build
pm2 start ecosystem.config.cjs --update-env
pm2 save
```

افحص التشغيل:

```bash
pm2 status
curl http://127.0.0.1:8080/healthz
```

إذا كان المنفذ `8080` مستخدما من خدمة أخرى:

```bash
sudo ss -tulpn | grep ':8080'
```

غيّر `PORT=8080` في `.env.server` إلى `PORT=8081` مثلا، ثم لاحقا غيّر `proxy_pass` في Nginx إلى نفس المنفذ.

## الخطوة 8: إعداد Nginx للصب دومين

انسخ ملف الإعداد:

```bash
sudo cp deploy/nginx/bazarvan-editor.conf /etc/nginx/sites-available/bazarvan-editor
sudo nano /etc/nginx/sites-available/bazarvan-editor
```

عدّل هذا السطر:

```nginx
server_name editor.example.com;
```

إلى صب دومينك الحقيقي، مثلا:

```nginx
server_name editor.yourdomain.com;
```

إذا غيرت المنفذ في `.env.server`، عدّل هذا السطر أيضا:

```nginx
proxy_pass http://127.0.0.1:8080;
```

فعّل الموقع:

```bash
sudo ln -s /etc/nginx/sites-available/bazarvan-editor /etc/nginx/sites-enabled/bazarvan-editor
sudo nginx -t
sudo systemctl reload nginx
```

افتح:

```text
http://editor.yourdomain.com
```

## الخطوة 9: تفعيل HTTPS

بعد أن يعمل الرابط بدون HTTPS:

```bash
sudo certbot --nginx -d editor.yourdomain.com
sudo systemctl reload nginx
```

بعدها افتح:

```text
https://editor.yourdomain.com
```

## الخطوة 10: عند تغيير حساب ChatGPT أو المفتاح

ادخل إلى السيرفر:

```bash
cd /var/www/bazarvan-editor
nano .env.server
```

غيّر:

```text
OPENAI_API_KEY=المفتاح_الجديد
```

ثم:

```bash
set -a
source .env.server
set +a
pm2 restart bazarvan-editor --update-env
```

لا تحتاج لتعديل الواجهة ولا GitHub إذا كان التغيير فقط مفتاح API.

## تحديث السيرفر بعد رفع تغييرات جديدة إلى GitHub

بعد أن نرفع التغييرات إلى GitHub:

```bash
cd /var/www/bazarvan-editor
git pull origin main
set -a
source .env.server
set +a
npm ci
npm run build
pm2 restart bazarvan-editor --update-env
```

## أوامر مفيدة للتشخيص

مشاهدة سجلات التطبيق:

```bash
pm2 logs bazarvan-editor
```

إعادة تشغيل التطبيق:

```bash
pm2 restart bazarvan-editor --update-env
```

فحص Nginx:

```bash
sudo nginx -t
sudo systemctl status nginx
```

فحص HTTPS لاحقا:

```bash
sudo certbot certificates
```

## ماذا سيكون مطلوبا منك عند النشر؟

ستحتاج فقط إلى هذه المعلومات:

- رابط GitHub للمشروع.
- IP السيرفر.
- الصب دومين الذي تريد استخدامه.
- مفاتيح Gemini الجديدة.
- مفتاح OpenAI الجديد.
- قيم Supabase:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

أما الكود فقد أصبح جاهزا لتشغيل API الذكاء الاصطناعي من السيرفر بدل المتصفح.
