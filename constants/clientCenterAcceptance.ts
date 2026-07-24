export const CLIENT_CENTER_ACCEPTANCE_VERSION = 10;

export const CLIENT_CENTER_ACCEPTANCE_CASES = [
  {
    id: 'scoped-client-permissions',
    label: 'صلاحيات العملاء والموظفين',
  },
  {
    id: 'registered-domain-only',
    label: 'منع الروابط خارج دومين العميل',
  },
  {
    id: 'duplicate-url-cleanup',
    label: 'تنظيف الروابط المكررة',
  },
  {
    id: 'redirect-and-canonical',
    label: 'التحويلات وCanonical',
  },
  {
    id: 'noindex-and-404',
    label: 'استبعاد noindex و404',
  },
  {
    id: 'arabic-and-english-extraction',
    label: 'استخراج العربية والإنجليزية',
  },
  {
    id: 'missing-description',
    label: 'الصفحات بلا وصف',
  },
  {
    id: 'generic-page-title',
    label: 'الصفحات ذات العنوان العام',
  },
  {
    id: 'anchor-text-accuracy',
    label: 'دقة Anchor Text',
  },
  {
    id: 'website-inventory-only',
    label: 'عدم استخدام مقالات المحرر',
  },
  {
    id: 'core-without-api-key',
    label: 'عمل المحرك دون أي مفتاح API',
  },
  {
    id: 'manual-fields-survive-recrawl',
    label: 'منع فقد التعديلات اليدوية بعد إعادة الزحف',
  },
  {
    id: 'crawl-resume-after-failure',
    label: 'الاستئناف بعد فشل مهمة الزحف',
  },
] as const;

export type ClientCenterAcceptanceCaseId =
  typeof CLIENT_CENTER_ACCEPTANCE_CASES[number]['id'];
