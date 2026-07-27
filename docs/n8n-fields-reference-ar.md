# جدول حقول n8n المقبولة في محرر Bazarvan

هذا الملف يوضح الحقول التي يمكن إرسالها من n8n إلى المسار:

```text
POST /api/n8n/articles
```

الهيدر المطلوب:

| النوع | الاسم | القيمة |
|---|---|---|
| Header | `Content-Type` | `application/json` |
| Header | `Authorization` | `Bearer YOUR_N8N_INGEST_TOKEN` |

> جميع حقول السياق العام، بما فيها `targetAudience` و`targetWordRange`، اختيارية ومدعومة. أي حقل لا يرسله n8n يبقى فارغًا، ولا يضع المحرر له قيمة افتراضية.

## الحقول الأساسية للمقالة

| الحقل الأساسي | أسماء بديلة مقبولة | مطلوب؟ | القيم أو النوع | ماذا يفعل؟ |
|---|---|---:|---|---|
| `title` | `articleTitle`, `article_title`, `headline` | نعم | نص | عنوان المقالة داخل المحرر. |
| `contentHtml` | `content_html`, `html`, `articleHtml`, `article_html` | نعم، إذا لم ترسل نصًا | HTML | محتوى المقالة بصيغة HTML. |
| `plainText` | `plain_text`, `text`, `contentText`, `content_text`, `articleText`, `article_text` | نعم، إذا لم ترسل HTML | نص | محتوى المقالة كنص عادي، وسيتم تحويله إلى فقرات HTML. |
| `content` | `body` | نعم، كبديل احتياطي | نص | بديل احتياطي إذا لم ترسل `contentHtml` أو `plainText`. |
| `contentJson` | `content_json` | لا | Object | محتوى منظم اختياري، يحفظ كما هو. |
| `externalId` | `external_id`, `id` | لا | نص فريد | إذا تكرر نفس المعرف يتم تحديث نفس المقالة بدل إنشاء مقالة جديدة. |
| `workflowId` | `workflow_id`, أو داخل `metadata.workflowId` | لا | نص | رقم أو اسم Workflow من n8n للحفظ والتتبع. |
| `executionId` | `execution_id`, أو داخل `metadata.executionId` | لا | نص | رقم تنفيذ n8n للحفظ والتتبع. |
| `metadata` | - | لا | Object | بيانات إضافية من n8n، تحفظ داخل بيانات المقالة. |

## اللغة والحالة والظهور

| الحقل | أسماء بديلة مقبولة | الافتراضي | الخيارات الممكنة | ملاحظات |
|---|---|---|---|---|
| `articleLanguage` | `article_language`, `language` | `ar` | `ar`, `en` | لغة المقالة. |
| `status` | - | `draft` | `draft`, `in_review`, `published`, `archived` | حالة المقالة. |
| `visibility` | - | `shared` أو `private` عند تحديد مستخدمين | `private`, `shared`, `team`, `public` | يتحكم في ظهور المقالة داخل قاعدة البيانات. |
| `accessRole` | `access_role` | `viewer` | `viewer`, `editor` | صلاحية المستخدمين المحددين: مشاهدة فقط أو تعديل. |

داخل لوحة التحكم، يستطيع الأدمن تعديل `visibility` و `accessRole` و `articleLanguage` و `status` من بطاقة المقالة. المستخدم العادي يستطيع تعديل `status` فقط، ويرى `accessRole` للمعرفة فقط.

## اختيار المستخدمين الذين تظهر لهم المقالة

| الحقل | أسماء بديلة مقبولة | النوع | ماذا يرسل؟ |
|---|---|---|---|
| `visibleTo` | `visible_to` | نص أو Array | بريد المستخدم أو ID المستخدم. |
| `visibleToUsers` | `visible_to_users` | نص أو Array | قائمة مستخدمين. |
| `visibleToEmails` | `visible_to_emails` | Array | قائمة إيميلات. |
| `visibleToEmailsCsv` | `visible_to_emails_csv` | نص | إيميلات مفصولة بفواصل. |
| `userEmail` | `user_email` | نص | بريد مستخدم واحد. |
| `ownerEmail` | `owner_email` | نص | مالك المقالة. |
| `ownerId` | `owner_id` | نص | ID مالك المقالة في Supabase. |
| `assignedTo` | `assigned_to` | نص | مستخدم مخصص للمقالة. |
| `assignedToId` | `assigned_to_id` | نص | ID المستخدم المخصص. |
| `assignedToEmail` | `assigned_to_email` | نص | بريد المستخدم المخصص. |

أمثلة:

```json
{
  "visibility": "private",
  "visibleToEmailsCsv": "user1@example.com,user2@example.com",
  "accessRole": "viewer"
}
```

```json
{
  "visibility": "private",
  "visibleToEmails": ["user1@example.com", "user2@example.com"],
  "accessRole": "editor"
}
```

## الكلمات المفتاحية

يمكن إرسال الكلمات داخل كائن `keywords` أو مباشرة في جسم الطلب.

| الحقل | مكان الإرسال | أسماء بديلة مقبولة | النوع | ملاحظات |
|---|---|---|---|---|
| `primary` | داخل `keywords` | `main`, `primaryKeyword`, `primary_keyword` | نص | الكلمة المفتاحية الرئيسية. |
| `primaryKeyword` | مباشر | `primary_keyword` | نص | بديل مباشر للكلمة الرئيسية. |
| `company` | داخل `keywords` أو مباشر | `companyName`, `company_name`, `brand` | نص | اسم الشركة أو العلامة. |
| `secondaries` | داخل `keywords` أو مباشر | - | Array أو نص | كلمات ثانوية. |
| `synonyms` | داخل `keywords` أو مباشر | - | Array أو نص | تضاف إلى الكلمات الثانوية. |
| `alternativeForms` | داخل `keywords` أو مباشر | `alternative_forms`, `alternatives` | Array أو نص | تضاف إلى الكلمات الثانوية. |
| `lsi` | داخل `keywords` أو مباشر | `lsiKeywords`, `lsi_keywords` | Array أو نص | كلمات LSI. |

الفواصل المقبولة في `alternativeForms` و `lsi`:

| الفاصل | مثال |
|---|---|
| فاصلة إنجليزية | `كلمة 1, كلمة 2` |
| فاصلة عربية | `كلمة 1، كلمة 2` |
| فاصلة منقوطة | `كلمة 1; كلمة 2` |
| فاصل عمودي | `كلمة 1 | كلمة 2` |
| نجمة | `كلمة 1 * كلمة 2` |
| شرطة مائلة | `كلمة 1 / كلمة 2` |
| نقطة | `كلمة 1. كلمة 2` |
| سطر جديد | كل كلمة في سطر |

مثال:

```json
{
  "keywords": {
    "primary": "السياحة في إسطنبول",
    "company": "Bazarvan",
    "alternativeForms": "رحلة إسطنبول * برنامج إسطنبول / زيارة إسطنبول، دليل إسطنبول",
    "lsi": "أماكن سياحية / مطاعم إسطنبول * تكلفة السفر. أفضل وقت للزيارة"
  }
}
```

## سياق الصفحة والجمهور

يمكن إرسال هذه الحقول مباشرة أو داخل أي كائن من الأسماء التالية:

```json
{
  "goalContext": {},
  "goal_context": {},
  "pageContext": {},
  "page_context": {},
  "generalContext": {},
  "general_context": {},
  "articleContext": {},
  "article_context": {},
  "contentContext": {},
  "content_context": {}
}
```

إذا أرسل الحقل مباشرة وفي كائن متداخل معًا، تكون القيمة المباشرة هي المعتمدة. يمكن إرسال حقول الاختيارات المتعددة كنص واحد أو Array، ويحوّلها المحرر إلى الصيغة الداخلية.

| الحقل | أسماء بديلة مقبولة | النوع |
|---|---|---|
| `targetWordRange` | `target_word_range`, `wordCountRange`, `word_count_range`, `wordRange`, `word_range`, `targetWords`, `target_words` | نص مثل `1200-1800`، أو Array مثل `[1200,1800]`، أو Object مثل `{"min":1200,"max":1800}`. يقبل أيضًا حدّين منفصلين مثل `min_words` و`max_words`. |
| `pageType` | `page_type`, `type` | اختيار مفرد |
| `objective` | `pageObjective`, `page_objective` | اختيار مفرد |
| `audienceScope` | `audience_scope`, `scope` | اختيار مفرد |
| `targetCountry` | `target_country`, `targetLocation`, `target_location`, `targetMarket`, `target_market`, `country` | نص |
| `targetAudience` | `target_audience`, `audience`, `audienceDescription`, `audience_description` | نص أو Array |
| `audienceKnowledgeLevel` | `audience_knowledge_level`, `knowledgeLevel`, `knowledge_level` | نص أو Array |
| `audienceNeeds` | `audience_needs`, `readerNeeds`, `reader_needs` | نص أو Array |
| `readerOutcome` | `reader_outcome`, `expectedOutcome`, `expected_outcome` | نص أو Array |
| `desiredAction` | `desired_action`, `callToAction`, `call_to_action`, `cta` | نص أو Array |
| `marketingStage` | `marketing_stage`, `funnelStage`, `funnel_stage` | نص أو Array |
| `uniqueAngle` | `unique_angle`, `contentAngle`, `content_angle` | نص أو Array |
| `evidenceRequirements` | `evidence_requirements`, `sourceRequirements`, `source_requirements` | نص أو Array |
| `freshnessRequirements` | `freshness_requirements`, `informationFreshness`, `information_freshness` | نص أو Array |
| `brandVoice` | `brand_voice`, `toneOfVoice`, `tone_of_voice` | نص أو Array |
| `topicSensitivity` | `topic_sensitivity`, `sensitivity` | نص أو Array |
| `searchIntent` | `search_intent`, `intent` | اختيار مفرد |
| `generatedBrief` | `generated_brief`, `smartBrief`, `smart_brief`, `contentBrief`, `content_brief` | نص |

لا توجد قيم افتراضية لحقول هذا القسم في مسار n8n: الحقل غير المرسل أو المرسل فارغًا يبقى فارغًا.

القيم الداخلية للاختيارات المفردة:

- `pageType`: `article`, `news`, `service`, `category`, `comparison`, `product`, `landing`, `guide`.
- `objective`: `educate`, `compare`, `convert`, `category-support`, `trust`, `support`.
- `audienceScope`: `local`, `country`, `regional`, `global`.
- `searchIntent`: `informational`, `commercial`, `commercial-support`, `transactional`, `navigational`, `support-intent`.

مثال:

```json
{
  "goalContext": {
    "targetWordRange": "1200/1800",
    "pageType": "مقالة/دليل",
    "objective": "شرح وتثقيف",
    "audienceScope": "country",
    "targetCountry": "تركيا",
    "targetAudience": ["business-owners", "decision-makers"],
    "audienceKnowledgeLevel": ["beginner", "non-technical"],
    "audienceNeeds": "clear-practical-answers",
    "readerOutcome": "make-informed-decision",
    "marketingStage": "consideration",
    "uniqueAngle": "practical-actionable",
    "evidenceRequirements": "official-primary-sources",
    "brandVoice": "formal-professional",
    "topicSensitivity": "standard",
    "searchIntent": "شرح وتعلّم",
    "generatedBrief": "موجز نصي اختياري قادم من n8n"
  }
}
```

## المنافسون

يمكن إرسال حتى 3 منافسين.

### الطريقة المنظمة

| الحقل | النوع | الخيارات داخل كل منافس |
|---|---|---|
| `competitors` | Array | `url`, `link`, `text`, `plainText`, `plain_text`, `html` |

مثال:

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

### الطريقة المنفصلة

| الحقل | أسماء بديلة مقبولة | ماذا يمثل؟ |
|---|---|---|
| `competitor1Url` | `competitor_1_url` | رابط المنافس الأول. |
| `competitor1Text` | `competitor_1_text`, `competitor1PlainText`, `competitor_1_plain_text` | نص المنافس الأول. |
| `competitor1Html` | `competitor_1_html` | HTML المنافس الأول. |
| `competitor2Url` | `competitor_2_url` | رابط المنافس الثاني. |
| `competitor2Text` | `competitor_2_text`, `competitor2PlainText`, `competitor_2_plain_text` | نص المنافس الثاني. |
| `competitor2Html` | `competitor_2_html` | HTML المنافس الثاني. |
| `competitor3Url` | `competitor_3_url` | رابط المنافس الثالث. |
| `competitor3Text` | `competitor_3_text`, `competitor3PlainText`, `competitor_3_plain_text` | نص المنافس الثالث. |
| `competitor3Html` | `competitor_3_html` | HTML المنافس الثالث. |

### طريقة القوائم

| الحقل | أسماء بديلة مقبولة | النوع |
|---|---|---|
| `competitorUrls` | `competitor_urls`, `competitorLinks`, `competitor_links` | Array أو نص مفصول بفواصل |
| `competitorTexts` | `competitor_texts` | Array أو نص مفصول بفواصل |
| `competitorHtmls` | `competitor_htmls` | Array أو نص مفصول بفواصل |

## التحليل والإحصائيات

| الحقل | النوع | ملاحظات |
|---|---|---|
| `analysis` | Object | يحفظ نتائج التحليل القادمة من n8n إذا أرسلتها. |
| `stats` | Object | يحفظ أرقام الإحصائيات. |

حقول `stats` المقبولة:

| الحقل داخل `stats` | النوع | الافتراضي |
|---|---|---:|
| `wordCount` | رقم | يتم حسابه تلقائيًا إذا لم يرسل |
| `keywordViolations` | رقم | `0` |
| `violatingCriteriaCount` | رقم | `0` |
| `totalErrorsCount` | رقم | `0` |
| `keywordDuplicatesCount` | رقم | `0` |
| `totalDuplicates` | رقم | `0` |
| `commonDuplicatesCount` | رقم | `0` |
| `uniqueWordsPercentage` | رقم | `0` |

## مثال شامل جاهز لـ n8n

```json
{
  "externalId": "{{$workflow.id}}-{{$execution.id}}",
  "workflowId": "{{$workflow.id}}",
  "executionId": "{{$execution.id}}",
  "title": "عنوان المقالة",
  "contentHtml": "<h1>عنوان المقالة</h1><p>نص المقالة هنا.</p>",
  "articleLanguage": "ar",
  "status": "draft",
  "visibility": "private",
  "visibleToEmailsCsv": "user1@example.com,user2@example.com",
  "accessRole": "viewer",
  "keywords": {
    "primary": "الكلمة الرئيسية",
    "company": "اسم الشركة",
    "alternativeForms": "صيغة أولى * صيغة ثانية / صيغة ثالثة، صيغة رابعة",
    "lsi": "كلمة LSI 1 / كلمة LSI 2 * كلمة LSI 3. كلمة LSI 4"
  },
  "goalContext": {
    "targetWordRange": "1200-1800",
    "pageType": "مقالة/دليل",
    "objective": "شرح وتثقيف",
    "audienceScope": "عالمي",
    "targetAudience": ["business-owners", "decision-makers"],
    "audienceKnowledgeLevel": "beginner",
    "audienceNeeds": "clear-practical-answers",
    "readerOutcome": "make-informed-decision",
    "marketingStage": "consideration",
    "uniqueAngle": "practical-actionable",
    "evidenceRequirements": "official-primary-sources",
    "brandVoice": "formal-professional",
    "topicSensitivity": "standard",
    "searchIntent": "شرح وتعلّم"
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
