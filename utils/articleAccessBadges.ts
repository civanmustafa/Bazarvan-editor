export type ArticleAccessBadgeRole = 'editor' | 'viewer';

export type ArticleAccessBadge = {
  key: string;
  name: string;
  role: ArticleAccessBadgeRole;
};

type AccessProfile = {
  id?: string | null;
  email?: string | null;
  fullName?: string | null;
};

type ArticleAccessSource = {
  ownerId?: string | null;
  createdBy?: string | null;
  assignedTo?: string | null;
  metadata?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

export const getArticleAccessDisplayName = (
  email?: string | null,
  fullName?: string | null,
): string => {
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';
  if (normalizedEmail) return normalizedEmail.split('@', 1)[0]?.trim() || '';

  const normalizedName = typeof fullName === 'string' ? fullName.trim() : '';
  return normalizedName.includes('@')
    ? normalizedName.split('@', 1)[0]?.trim() || ''
    : normalizedName;
};

const normalizeRole = (value: unknown, fallback: ArticleAccessBadgeRole): ArticleAccessBadgeRole => (
  value === 'editor' ? 'editor' : value === 'viewer' ? 'viewer' : fallback
);

const splitVisibleEmails = (value: unknown): string[] => (
  typeof value === 'string'
    ? Array.from(new Set(value
        .split(/[\n\r,،;؛|]+/g)
        .map(email => email.trim().toLowerCase())
        .filter(Boolean)))
    : []
);

export const getArticleAccessBadges = (
  article: ArticleAccessSource,
  profiles: AccessProfile[] = [],
): ArticleAccessBadge[] => {
  const badges = new Map<string, ArticleAccessBadge>();
  const badgeKeyByAlias = new Map<string, string>();
  const profilesById = new Map(
    profiles
      .filter(profile => typeof profile.id === 'string' && profile.id)
      .map(profile => [profile.id as string, profile]),
  );

  const addBadge = (input: AccessProfile, role: ArticleAccessBadgeRole): void => {
    const name = getArticleAccessDisplayName(input.email, input.fullName);
    if (!name) return;
    const normalizedEmail = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const normalizedId = typeof input.id === 'string' ? input.id.trim() : '';
    const aliases = [
      normalizedId ? `id:${normalizedId}` : '',
      normalizedEmail ? `email:${normalizedEmail}` : '',
    ].filter(Boolean);
    if (aliases.length === 0) aliases.push(`name:${name.toLocaleLowerCase()}`);
    const key = aliases.map(alias => badgeKeyByAlias.get(alias)).find(Boolean) || aliases[0];
    const existing = badges.get(key);
    badges.set(key, {
      key,
      name,
      role: existing?.role === 'editor' || role === 'editor' ? 'editor' : 'viewer',
    });
    aliases.forEach(alias => badgeKeyByAlias.set(alias, key));
  };

  const addProfileById = (profileId: string | null | undefined, role: ArticleAccessBadgeRole): void => {
    if (!profileId) return;
    const profile = profilesById.get(profileId);
    if (profile) addBadge(profile, role);
  };

  addProfileById(article.ownerId, 'editor');
  addProfileById(article.assignedTo, 'editor');
  addProfileById(article.createdBy, 'viewer');

  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const n8nSettings = isRecord(metadata.n8nSettings) ? metadata.n8nSettings : {};
  const fallbackRole = normalizeRole(n8nSettings.accessRole, 'viewer');
  const visibleTo = Array.isArray(metadata.visibleTo) ? metadata.visibleTo : [];

  visibleTo.forEach(value => {
    if (!isRecord(value)) return;
    const id = typeof value.id === 'string' ? value.id : null;
    const profile = id ? profilesById.get(id) : undefined;
    addBadge({
      id,
      email: typeof value.email === 'string' ? value.email : profile?.email,
      fullName: typeof value.fullName === 'string' ? value.fullName : profile?.fullName,
    }, normalizeRole(value.role, fallbackRole));
  });

  splitVisibleEmails(n8nSettings.visibleToEmailsCsv).forEach(email => {
    addBadge({ email }, fallbackRole);
  });

  return [...badges.values()].sort((left, right) => {
    if (left.role !== right.role) return left.role === 'editor' ? -1 : 1;
    return left.name.localeCompare(right.name, 'ar');
  });
};
