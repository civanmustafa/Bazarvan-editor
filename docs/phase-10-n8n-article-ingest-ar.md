# المرحلة 10: ربط n8n بإنشاء مقالات داخل المحرر

هذا الدليل يشرح كيف تجعل n8n يرسل مقالة إلى المحرر، ثم تظهر المقالة داخل لوحة المستخدمين حسب اختيارك.

## ماذا تم تنفيذه في الكود؟

تمت إضافة API جديد داخل المحرر:

```text
POST https://YOUR_EDITOR_SUBDOMAIN/api/n8n/articles
```

هذا الرابط يستقبل المقالات من n8n ويحفظها داخل Supabase في جدول:

```text
articles
```

كما تم إضافة جدول صلاحيات جديد:

```text
article_access
```

حتى يستطيع n8n اختيار من تظهر له المقالة.

كما أصبحت لوحة الأدمن تعرض على بطاقة كل مقالة، وداخل تفاصيل المقالة، إعدادات n8n التالية:

```text
visibility
accessRole
articleLanguage
status
```

## كيف يتم اختيار من يرى المقالة؟

لديك 3 طرق:

### 1. تظهر لكل المستخدمين المسجلين

أرسل:

```json
{
  "visibility": "shared"
}
```

### 2. تظهر لمستخدم واحد أو عدة مستخدمين

أرسل:

```json
{
  "visibleToEmails": ["user1@example.com", "user2@example.com"],
  "accessRole": "viewer"
}
```

إذا أردت أن يستطيع المستخدم التعديل والحفظ، استخدم:

```json
{
  "accessRole": "editor"
}
```

### 3. تظهر كصفحة عامة داخل النظام

أرسل:

```json
{
  "visibility": "public"
}
```

## الحقول التي يستقبلها الرابط

الحقول الأساسية:

```json
{
  "externalId": "article-unique-id",
  "title": "عنوان المقالة",
  "contentHtml": "<h1>عنوان</h1><p>نص المقالة</p>",
  "plainText": "نص المقالة بدون HTML",
  "articleLanguage": "ar",
  "status": "draft",
  "visibility": "shared"
}
```

حقول الكلمات:

```json
{
  "keywords": {
    "primary": "الكلمة الرئيسية",
    "company": "اسم الشركة",
    "alternativeForms": ["صيغة بديلة 1", "صيغة بديلة 2"],
    "lsi": ["كلمة LSI 1", "كلمة LSI 2"]
  }
}
```

يمكنك أيضا إرسال الصيغ البديلة بهذه الأسماء:

```text
secondaries
synonyms
alternativeForms
alternatives
```

ويمكنك إرسال كلمات LSI بهذه الأسماء:

```text
lsi
lsiKeywords
lsi_keywords
```

سياق الصفحة والجمهور:

```json
{
  "goalContext": {
    "pageType": "article",
    "objective": "educate",
    "audienceScope": "global",
    "targetCountry": "",
    "searchIntent": "informational"
  }
}
```

مهم: إذا كان أي حقل فارغا، لا تحتاج إرساله أصلا. وإذا أرسله n8n فارغا، سيقوم المحرر بتجاهله عند الحفظ.

تم حذف `targetAudience` من مسار n8n، لذلك لا ترسله.

## القيم التي يمكن إرسالها لسياق الصفحة

يمكنك إرسال القيم الداخلية الإنجليزية أو نفس النص الظاهر في واجهة المحرر.

`pageType` يقبل مثلا:

```text
article أو مقالة/دليل
news أو خبر
service أو خدمة
category أو تصنيف منتجات/خدمات
comparison أو مقارنة
product أو منتج
landing أو هبوط
guide أو دليل
```

`objective` يقبل مثلا:

```text
educate أو شرح وتثقيف
compare أو مقارنة ومساعدة على الاختيار
convert أو تحويل مباشر
category-support أو محتوى داعم لصفحة تصنيف
trust أو بناء الثقة وتقليل الاعتراضات
support أو دعم بعد القرار أو الاستخدام
```

`audienceScope` يقبل:

```text
local أو مدينة أو منطقة محلية
country أو دولة واحدة محددة
regional أو إقليم
global أو عالمي
```

`searchIntent` يقبل:

```text
informational أو شرح وتعلّم
commercial أو مقارنة واختيار
commercial-support أو معلومات تجارية داعمة
transactional أو تنفيذ إجراء/شراء
navigational أو الوصول إلى علامة أو صفحة محددة
support-intent أو حل مشكلة أو معرفة طريقة الاستخدام
```

## فواصل الصيغ البديلة و LSI

حقلا:

```text
alternativeForms
lsi
```

يمكن أن يصلا كقائمة JSON أو كنص واحد. إذا أرسلتهما كنص واحد، سيتعرف المحرر على الفواصل الشائعة مثل:

```text
,
،
;
؛
|
*
/
#
.
سطر جديد
```

مثال:

```json
{
  "alternativeForms": "صيغة أولى * صيغة ثانية / صيغة ثالثة، صيغة رابعة",
  "lsi": "LSI 1 / LSI 2 * LSI 3. LSI 4"
}
```

## إرسال المنافسين من n8n

يمكن إرسال حتى 3 منافسين مع المقالة.

الطريقة المنظمة:

```json
{
  "competitors": [
    {
      "url": "https://example.com/competitor-1",
      "text": "نص المنافس الأول"
    },
    {
      "url": "https://example.com/competitor-2",
      "text": "نص المنافس الثاني"
    },
    {
      "url": "https://example.com/competitor-3",
      "text": "نص المنافس الثالث"
    }
  ]
}
```

أو يمكن إرسالها كحقول منفصلة:

```json
{
  "competitor1Url": "https://example.com/1",
  "competitor1Text": "نص المنافس الأول",
  "competitor2Url": "https://example.com/2",
  "competitor2Text": "نص المنافس الثاني",
  "competitor3Url": "https://example.com/3",
  "competitor3Text": "نص المنافس الثالث"
}
```

يمكن أيضا إرسال HTML:

```json
{
  "competitor1Html": "<main>HTML المنافس الأول</main>"
}
```

عند فتح المقالة داخل المحرر، سيتم استعادة روابط ونصوص المنافسين داخل تبويب المنافسين.

## القيم المسموحة

`articleLanguage`:

```text
ar
en
```

`status`:

```text
draft
in_review
published
archived
```

`visibility`:

```text
private
shared
team
public
```

`accessRole`:

```text
viewer
editor
```

## الخطوة 1: تطبيق تحديث قاعدة البيانات في Supabase

افتح Supabase:

```text
SQL Editor
```

ثم افتح هذا الملف من المشروع:

```text
supabase/migrations/20260701010000_phase_n8n_article_access.sql
```

انسخ محتواه كاملا والصقه في SQL Editor ثم اضغط Run.

هذه الخطوة تنشئ جدول `article_access` وتحدث سياسات القراءة والتعديل.

## الخطوة 2: تجهيز مفاتيح السيرفر

افتح السيرفر عبر SSH:

```bash
ssh root@YOUR_SERVER_IP
```

ادخل إلى مجلد المشروع:

```bash
cd /var/www/bazarvan-editor
```

افتح ملف البيئة:

```bash
nano .env.server
```

أضف هذه القيم:

```env
N8N_INGEST_TOKEN=ضع_توكن_طويل_وسري_هنا
SUPABASE_SERVICE_ROLE_KEY=ضع_مفتاح_Supabase_السري_هنا
```

لإنشاء توكن طويل على السيرفر:

```bash
openssl rand -hex 32
```

انسخ الناتج وضعه في:

```env
N8N_INGEST_TOKEN=
```

مفتاح `SUPABASE_SERVICE_ROLE_KEY` تجده في Supabase من:

```text
Project Settings > API Keys
```

استخدم Secret key أو service_role key فقط على السيرفر. لا تضع هذا المفتاح داخل المتصفح ولا داخل أي متغير يبدأ بـ `VITE_`.

للحفظ داخل nano:

```text
Ctrl + O
Enter
Ctrl + X
```

## الخطوة 3: تحديث السيرفر بعد رفع الكود

بعد رفع التعديلات إلى GitHub، نفذ على السيرفر:

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

افحص الصحة:

```bash
curl https://YOUR_EDITOR_SUBDOMAIN/healthz
```

يجب أن ترى:

```json
"n8nConfigured": true
```

## الخطوة 4: إعداد n8n

داخل n8n افتح Workflow المقالات.

أضف في النهاية Node من نوع:

```text
HTTP Request
```

الإعدادات:

```text
Method: POST
URL: https://YOUR_EDITOR_SUBDOMAIN/api/n8n/articles
Send Body: JSON
```

Headers:

```text
Content-Type: application/json
Authorization: Bearer YOUR_N8N_INGEST_TOKEN
```

استبدل `YOUR_N8N_INGEST_TOKEN` بنفس التوكن الذي وضعته في `.env.server`.

## مثال JSON لمقالة تظهر لكل المستخدمين

```json
{
  "externalId": "{{$workflow.id}}-{{$execution.id}}",
  "workflowId": "{{$workflow.id}}",
  "executionId": "{{$execution.id}}",
  "title": "عنوان المقالة من n8n",
  "contentHtml": "<h1>عنوان المقالة</h1><p>هذا نص المقالة.</p>",
  "articleLanguage": "ar",
  "status": "draft",
  "visibility": "shared",
  "keywords": {
    "primary": "الكلمة الرئيسية",
    "company": "اسم الشركة",
    "alternativeForms": ["صيغة بديلة 1", "صيغة بديلة 2"],
    "lsi": ["كلمة LSI 1", "كلمة LSI 2"]
  },
  "goalContext": {
    "pageType": "article",
    "objective": "educate",
    "audienceScope": "global",
    "searchIntent": "informational"
  },
  "competitors": [
    {
      "url": "https://example.com/competitor-1",
      "text": "نص المنافس الأول"
    },
    {
      "url": "https://example.com/competitor-2",
      "text": "نص المنافس الثاني"
    },
    {
      "url": "https://example.com/competitor-3",
      "text": "نص المنافس الثالث"
    }
  ]
}
```

## مثال JSON يستخدم القيم العربية من واجهة المحرر

```json
{
  "externalId": "arabic-values-example-001",
  "title": "مقالة بقيم عربية",
  "plainText": "هذا نص المقالة.",
  "articleLanguage": "ar",
  "visibility": "shared",
  "keywords": {
    "primary": "الكلمة الرئيسية",
    "alternativeForms": "صيغة بديلة 1 * صيغة بديلة 2 / صيغة بديلة 3",
    "lsi": "كلمة LSI 1، كلمة LSI 2 / كلمة LSI 3"
  },
  "goalContext": {
    "pageType": "مقالة/دليل",
    "objective": "شرح وتثقيف",
    "audienceScope": "عالمي",
    "searchIntent": "شرح وتعلّم"
  }
}
```

## مثال JSON لمقالة تظهر لمستخدمين محددين فقط

```json
{
  "externalId": "client-a-article-001",
  "title": "مقالة خاصة بفريق محدد",
  "plainText": "نص المقالة هنا.",
  "articleLanguage": "ar",
  "status": "draft",
  "visibleToEmails": ["user1@example.com", "user2@example.com"],
  "accessRole": "viewer",
  "keywords": {
    "primary": "الكلمة الرئيسية",
    "alternativeForms": ["صيغة بديلة"],
    "lsi": ["كلمة LSI"]
  }
}
```

إذا أردت أن يستطيع هؤلاء المستخدمون تعديل المقالة وحفظها:

```json
{
  "accessRole": "editor"
}
```

## ماذا يحدث عند تكرار نفس externalId؟

إذا أرسل n8n نفس:

```text
externalId
```

مرة أخرى، لن ينشئ المحرر مقالة جديدة. سيقوم بتحديث نفس المقالة.

لذلك الأفضل أن تجعل `externalId` ثابتا لكل مقالة.

## اختبار سريع بدون n8n

من السيرفر يمكنك اختبار الرابط:

```bash
curl -X POST "https://YOUR_EDITOR_SUBDOMAIN/api/n8n/articles" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_N8N_INGEST_TOKEN" \
  -d '{
    "externalId": "test-from-curl-001",
    "title": "اختبار من curl",
    "plainText": "هذه مقالة اختبارية من السيرفر.",
    "articleLanguage": "ar",
    "visibility": "shared",
    "keywords": {
      "primary": "اختبار المحرر",
      "alternativeForms": ["تجربة المحرر"],
      "lsi": ["ربط n8n"]
    }
  }'
```

إذا نجح الطلب سترى ردا يشبه:

```json
{
  "ok": true,
  "status": "created",
  "articleId": "...",
  "visibility": "shared"
}
```

## أين تظهر المقالة؟

بعد نجاح الطلب:

1. افتح المحرر.
2. سجل الدخول.
3. ادخل إلى لوحة التحكم.
4. اضغط تحديث إذا لم تظهر مباشرة.
5. ستظهر المقالة حسب اختيار الظهور:
   - `visibility: shared` تظهر للجميع داخل المحرر.
   - `visibleToEmails` تظهر للمستخدمين المحددين.
   - الأدمن يراها دائما.

## أخطاء شائعة

### 401 Unauthorized

يعني أن التوكن في n8n لا يطابق:

```env
N8N_INGEST_TOKEN
```

### 503 SUPABASE_SERVICE_ROLE_KEY is not configured

يعني أن مفتاح Supabase السري غير موجود في `.env.server` أو لم تعد تشغيل PM2 مع `--update-env`.

نفذ:

```bash
set -a
source .env.server
set +a
pm2 restart bazarvan-editor --update-env
```

### Could not find Supabase profiles

يعني أنك أرسلت بريدا داخل `visibleToEmails` غير موجود في:

```text
Supabase > Authentication > Users
```

أو لا يوجد له صف في جدول:

```text
profiles
```

اجعل المستخدم يسجل الدخول مرة واحدة، أو أنشئ صفه في `profiles`.
