import type { ClientGoalContexts, GoalContext, Keywords } from '../types';
import type { ClientCenterClient } from './clientCenter';

const normalizeName = (value: string): string => value.trim().toLocaleLowerCase();

const ARABIC_SCRIPT_PATTERN = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/u;
const LATIN_SCRIPT_PATTERN = /[a-z]/iu;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export const inferClientDefaultLanguage = (
  primaryKeyword: string,
  fallbackLanguage = 'ar',
): string => {
  if (ARABIC_SCRIPT_PATTERN.test(primaryKeyword)) return 'ar';
  if (LATIN_SCRIPT_PATTERN.test(primaryKeyword)) return 'en';

  const normalizedFallback = fallbackLanguage.trim().toLowerCase();
  return LANGUAGE_CODE_PATTERN.test(normalizedFallback) ? normalizedFallback : 'ar';
};

export const resolveCompanyClient = (
  clients: ClientCenterClient[],
  keywords: Pick<Keywords, 'clientId' | 'company'>,
  linkedClientId = '',
): ClientCenterClient | null => {
  const preferredIds = [linkedClientId.trim(), keywords.clientId?.trim() || ''].filter(Boolean);
  for (const clientId of preferredIds) {
    const client = clients.find(candidate => candidate.id === clientId);
    if (client) return client;
  }

  const companyName = normalizeName(keywords.company);
  if (!companyName) return null;
  return clients.find(client => normalizeName(client.name) === companyName) ?? null;
};

export const getClientGoalContext = (
  contexts: ClientGoalContexts,
  client: Pick<ClientCenterClient, 'id' | 'name'>,
): GoalContext | undefined => contexts[client.id] ?? contexts[client.name];

export const hasClientGoalContext = (
  contexts: ClientGoalContexts,
  client: Pick<ClientCenterClient, 'id' | 'name'> | null,
): boolean => Boolean(client && getClientGoalContext(contexts, client));

export const buildUnifiedCompanyKeywords = (
  keywords: Keywords,
  client: Pick<ClientCenterClient, 'id' | 'name'>,
): Keywords => ({
  ...keywords,
  clientId: client.id,
  company: client.name,
});

export const mapNamedGoalContextsToClients = (
  contexts: ClientGoalContexts,
  clients: ClientCenterClient[],
): ClientGoalContexts => {
  const clientsByName = new Map(
    clients.map(client => [normalizeName(client.name), client] as const),
  );

  return Object.entries(contexts).reduce<ClientGoalContexts>((result, [name, context]) => {
    const client = clientsByName.get(normalizeName(name));
    if (client) result[client.id] = context;
    return result;
  }, {});
};
