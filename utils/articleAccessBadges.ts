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
  role?: 'admin' | 'user' | string | null;
};

type ArticleAccessSource = {
  ownerId?: string | null;
  createdBy?: string | null;
  assignedTo?: string | null;
  metadata?: unknown;
};

type ArticleAccessUser = {
  id?: string | null;
  email?: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const PRIMARY_ADMIN_EMAIL = 'ciwan.mu90@gmail.com';

export const isImplicitArticleAdministrator = (profile?: AccessProfile | null): boolean => {
  if (!profile) return false;
  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : '';
  return profile.role === 'admin' || email === PRIMARY_ADMIN_EMAIL;
};

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

export const isArticleAssignedToUser = (
  article: ArticleAccessSource,
  user: ArticleAccessUser,
): boolean => getArticleAssignmentRoleForUser(article, user) !== null;

export const getArticleAssignmentRoleForUser = (
  article: ArticleAccessSource,
  user: ArticleAccessUser,
): ArticleAccessBadgeRole | null => {
  const userId = typeof user.id === 'string' ? user.id.trim() : '';
  const userEmail = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!userId && !userEmail) return null;

  if (userId && [article.ownerId, article.assignedTo].some(value => (
    typeof value === 'string' && value.trim() === userId
  ))) {
    return 'editor';
  }

  const metadata = isRecord(article.metadata) ? article.metadata : {};
  const n8nSettings = isRecord(metadata.n8nSettings) ? metadata.n8nSettings : {};
  const fallbackRole = normalizeRole(n8nSettings.accessRole, 'viewer');
  const visibleTo = Array.isArray(metadata.visibleTo) ? metadata.visibleTo : [];
  let explicitRole: ArticleAccessBadgeRole | null = null;
  visibleTo.forEach(value => {
    if (!isRecord(value)) return;
    const assignedId = typeof value.id === 'string' ? value.id.trim() : '';
    const assignedEmail = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
    const matches = Boolean(
      (userId && assignedId === userId)
      || (userEmail && assignedEmail === userEmail)
    );
    if (!matches) return;
    const role = normalizeRole(value.role, fallbackRole);
    if (role === 'editor' || explicitRole === null) explicitRole = role;
  });
  if (explicitRole) return explicitRole;

  if (
    userEmail
    && splitVisibleEmails(n8nSettings.visibleToEmailsCsv).includes(userEmail)
  ) {
    return fallbackRole;
  }

  if (userId && typeof article.createdBy === 'string' && article.createdBy.trim() === userId) {
    return 'viewer';
  }
  return null;
};

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
  const profilesByEmail = new Map(
    profiles
      .filter(profile => typeof profile.email === 'string' && profile.email.trim())
      .map(profile => [profile.email!.trim().toLowerCase(), profile]),
  );

  const addBadge = (input: AccessProfile, role: ArticleAccessBadgeRole): void => {
    const normalizedId = typeof input.id === 'string' ? input.id.trim() : '';
    const normalizedEmail = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const knownProfile = (normalizedId ? profilesById.get(normalizedId) : undefined)
      || (normalizedEmail ? profilesByEmail.get(normalizedEmail) : undefined);
    const resolvedInput = knownProfile ? {
      id: input.id ?? knownProfile.id,
      email: input.email ?? knownProfile.email,
      fullName: input.fullName ?? knownProfile.fullName,
      role: input.role ?? knownProfile.role,
    } : input;
    if (isImplicitArticleAdministrator(resolvedInput)) return;
    const name = getArticleAccessDisplayName(resolvedInput.email, resolvedInput.fullName);
    if (!name) return;
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
      role: profile?.role,
    }, normalizeRole(value.role, fallbackRole));
  });

  splitVisibleEmails(n8nSettings.visibleToEmailsCsv).forEach(email => {
    addBadge(profilesByEmail.get(email) || { email }, fallbackRole);
  });

  return [...badges.values()].sort((left, right) => {
    if (left.role !== right.role) return left.role === 'editor' ? -1 : 1;
    return left.name.localeCompare(right.name, 'ar');
  });
};
