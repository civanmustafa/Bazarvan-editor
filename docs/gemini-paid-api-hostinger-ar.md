# تفعيل Gemini Pro المدفوع على السيرفر

هذا المشروع يحتوي على مسار API خلفي للإنتاج:

```text
/api/gemini
```

المسار يعمل داخل Node/Express على Hostinger، ولا يضع مفاتيح Gemini داخل المتصفح.

## ما الذي تغيّر؟

- زر Gemini العادي يستخدم مفاتيح:

```bash
GEMINI_API_KEYS
```

- زر Gemini Pro المدفوع يستخدم مفاتيح منفصلة:

```bash
GEMINI_PAID_API_KEYS
```

- النموذج الافتراضي لـ Gemini العادي:

```bash
GEMINI_MODEL=gemini-2.5-flash
```

- النموذج الافتراضي لـ Gemini Pro:

```bash
GEMINI_PAID_MODEL=gemini-2.5-pro
```

## الخطوات على Hostinger VPS

ادخل إلى السيرفر عبر SSH، ثم افتح ملف البيئة أو ملف إعدادات PM2 الذي تستخدمه لتخزين المفاتيح.

إذا كنت تستخدم متغيرات البيئة مباشرة مع PM2، أضف القيم بهذا الشكل:

```bash
export GEMINI_API_KEYS="ضع_مفتاح_جيميني_العادي_هنا"
export GEMINI_PAID_API_KEYS="ضع_مفتاح_جيميني_برو_المدفوع_هنا"
export GEMINI_MODEL="gemini-2.5-flash"
export GEMINI_PAID_MODEL="gemini-2.5-pro"
```

إذا كان لديك أكثر من مفتاح، افصل بينها بفاصلة:

```bash
export GEMINI_PAID_API_KEYS="key_1,key_2,key_3"
```

متغير اختياري فقط إذا أردت السماح بموديلات إضافية لاحقًا:

```bash
export GEMINI_ALLOWED_MODELS="model_1,model_2"
```

بعدها حدّث المشروع وشغّله:

```bash
cd /مسار/المحرر/على/السيرفر
git pull origin main
npm ci
npm run build
pm2 restart bazarvan-editor --update-env
```

إذا كان اسم تطبيق PM2 مختلفًا عن `bazarvan-editor`، اعرف الاسم بهذا الأمر:

```bash
pm2 list
```

ثم استبدل الاسم في أمر restart.

## طريقة التحقق

افتح رابط الصحة:

```text
https://subdomain.your-domain.com/healthz
```

يجب أن ترى داخل `ai`:

```json
{
  "geminiConfigured": true,
  "geminiPaidConfigured": true
}
```

بعد ذلك جرّب من المحرر:

1. افتح مقالة.
2. افتح لوحة التحليل.
3. اضغط زر `Pro`.
4. إذا كان المفتاح المدفوع صحيحًا، سيعمل التحليل عبر Gemini Pro.

## ملاحظات مهمة

- لا تضع `GEMINI_PAID_API_KEYS` داخل أي متغير يبدأ بـ `VITE_`.
- أي متغير يبدأ بـ `VITE_` يمكن أن يصل للمتصفح، لذلك مفاتيح AI يجب أن تبقى بدون `VITE_`.
- إذا ظهر خطأ يقول إن مفاتيح Gemini Pro غير مكوّنة، فهذا يعني أن السيرفر لا يرى `GEMINI_PAID_API_KEYS` أو أنك لم تستخدم:

```bash
pm2 restart bazarvan-editor --update-env
```

- إذا ظهر خطأ quota أو billing، فالمشكلة من مشروع Google نفسه: يجب تفعيل الفوترة أو استخدام مفتاح من مشروع لديه صلاحية Gemini Pro.
