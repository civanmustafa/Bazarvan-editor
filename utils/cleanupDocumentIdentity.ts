// Highlight marks are transient analysis decorations, not article revisions.
export function cleanupDocumentIdentity(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().flatMap(key => {
      let next = record[key];
      if (key === 'content' && record.type === 'doc' && Array.isArray(next)) {
        const content = [...next];
        while (content.length > 1 && content.at(-1)?.type === 'paragraph'
          && !content.at(-1)?.content?.length) content.pop();
        next = content;
      }
      if (key === 'marks' && Array.isArray(next)) next = next.filter(mark => mark.type !== 'highlight');
      if (next == null || (Array.isArray(next) && !next.length && key === 'marks')) return [];
      const normalized = normalize(next);
      if (key === 'attrs' && !Object.keys(normalized as object).length) return [];
      return [[key, normalized]];
    }));
  };
  return JSON.stringify(normalize(value));
}
