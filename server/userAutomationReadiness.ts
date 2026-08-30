import { getExternalAnalysisSupabaseAdmin } from './externalAnalysisQueue';

export const checkUserAutomationReadiness = async (): Promise<{ ok: boolean; schemaVersion: number }> => {
  try {
    const admin = getExternalAnalysisSupabaseAdmin();
    const [version, preferences, articles] = await Promise.all([
      admin.rpc('creator_article_automation_schema_version'),
      admin.from('user_automation_settings').select('user_id,preferences,created_at,updated_at').limit(0),
      admin.from('articles').select('id,automation_policy_version,automation_creator_id').limit(0),
    ]);
    const schemaVersion = Number(version.data) || 0;
    return { ok: !version.error && !preferences.error && !articles.error && schemaVersion === 1, schemaVersion };
  } catch { return { ok: false, schemaVersion: 0 }; }
};
