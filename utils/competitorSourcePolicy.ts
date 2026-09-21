import {
  TRUSTED_GOVERNMENT_COMPETITOR_MIN_UNIQUE_TOKENS,
  TRUSTED_GOVERNMENT_COMPETITOR_MIN_WORDS,
  TRUSTED_GOVERNMENT_COMPETITOR_WEIGHT,
} from '../constants/competitors';

export type CompetitorSourceClass = 'commercial' | 'government';

export type CompetitorSourcePolicy = {
  sourceClass: CompetitorSourceClass;
  minimumWordCount: number;
  minimumUniqueTokenCount: number;
  contentWeight: number;
};

const STANDARD_POLICY: CompetitorSourcePolicy = {
  sourceClass: 'commercial',
  minimumWordCount: 250,
  minimumUniqueTokenCount: 35,
  contentWeight: 1,
};

const GOVERNMENT_POLICY: CompetitorSourcePolicy = {
  sourceClass: 'government',
  minimumWordCount: TRUSTED_GOVERNMENT_COMPETITOR_MIN_WORDS,
  minimumUniqueTokenCount: TRUSTED_GOVERNMENT_COMPETITOR_MIN_UNIQUE_TOKENS,
  contentWeight: TRUSTED_GOVERNMENT_COMPETITOR_WEIGHT,
};

const hostnameFromValue = (value: unknown): string => {
  const raw = String(value || '').trim().toLocaleLowerCase();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
      .hostname
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  } catch {
    return raw.split('/')[0].replace(/^www\./, '').replace(/\.$/, '');
  }
};

/**
 * Deliberately narrow: only official government namespaces and two established
 * UAE government portals qualify for the lower source-size threshold.
 */
export const isTrustedGovernmentCompetitorSource = (value: unknown): boolean => {
  const hostname = hostnameFromValue(value);
  if (!hostname) return false;
  if (hostname === 'u.ae' || hostname.endsWith('.u.ae') || hostname === 'government.ae') return true;
  return /(^|\.)(gov|gouv|gob|go|gc|govt)\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(hostname)
    || /(^|\.)gov$/i.test(hostname);
};

export const resolveCompetitorSourcePolicy = (value: unknown): CompetitorSourcePolicy => (
  isTrustedGovernmentCompetitorSource(value) ? GOVERNMENT_POLICY : STANDARD_POLICY
);
