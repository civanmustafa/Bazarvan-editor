import { Extension, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { DOMSerializer } from '@tiptap/pm/model';
import { parseHTML } from 'linkedom';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import type { Keywords } from '../types';
import { collectCleanupSnapshot, type CleanupSnapshot } from '../utils/duplicateCleanup';
import { runDuplicateAnalysis } from '../utils/analysis/runDuplicateAnalysis';

const Direction = Extension.create({ name: 'cleanupDirection', addGlobalAttributes() {
  return [{ types: ['heading', 'paragraph', 'listItem', 'bulletList', 'orderedList'], attributes: {
    dir: { default: null, renderHTML: attrs => attrs.dir ? { dir: attrs.dir } : {} },
  } }];
} });
const CleanupHighlight = Highlight.extend({ addAttributes() { return { ...this.parent?.(),
  violation: { default: null }, from: { default: null }, isViolation: { default: false }, highlightStyle: { default: 'background' },
}; } }).configure({ multicolor: true });
const schema = getSchema([StarterKit.configure({ link: false }), Link.configure({ HTMLAttributes: { rel: 'noopener', target: '_self' } }), CleanupHighlight, Direction,
  TextAlign.configure({ types: ['heading', 'paragraph', 'listItem', 'tableCell', 'tableHeader'] }), Table, TableRow, TableCell, TableHeader]);
export type CleanupJobInput = {
  version: 1; category: number; language: 'ar' | 'en'; title: string;
  document: Record<string, unknown>; keywords: Keywords; snapshot: CleanupSnapshot;
};

export function readCleanupDocument(document: unknown) {
  const checkAttributes = (value: any, mark = false): void => {
    if (!value || typeof value !== 'object') throw new Error('Invalid cleanup document.');
    const type = mark ? schema.marks[value.type] : schema.nodes[value.type];
    if (!type) throw new Error(`Unsupported editor element: ${value.type}`);
    if (Object.keys(value.attrs || {}).some(key => !Object.hasOwn(type.spec.attrs || {}, key))) {
      throw new Error('Unsupported editor formatting; automatic cleanup must preserve the original.');
    }
    for (const child of value.content || []) checkAttributes(child);
    for (const child of value.marks || []) checkAttributes(child, true);
  };
  checkAttributes(document);
  const doc = schema.nodeFromJSON(document);
  doc.check();
  if (doc.type.name !== 'doc') throw new Error('A complete editor document is required.');
  return doc;
}

export function serializeCleanupDocument(json: unknown) {
  const doc = readCleanupDocument(json);
  const { document } = parseHTML('<html><body></body></html>');
  document.body.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: document as unknown as Document }));
  return { document: doc.toJSON() as Record<string, unknown>, html: document.body.innerHTML,
    text: doc.textBetween(0, doc.content.size, '\n\n', '\uFFFC') };
}

export function prepareCleanupJobInput(body: Record<string, unknown>): CleanupJobInput {
  if (!Number.isInteger(body.category) || Number(body.category) < 2 || Number(body.category) > 8
    || !['ar', 'en'].includes(String(body.language))
    || !body.document || typeof body.document !== 'object'
    || JSON.stringify(body.document).length > 600_000) throw new Error('Invalid or oversized cleanup input.');
  const source = body.keywords as Partial<Keywords> | undefined;
  const terms = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((term): term is string => typeof term === 'string').slice(0, 500).map(term => term.slice(0, 500)) : [];
  const keywords: Keywords = { primary: String(source?.primary || '').slice(0, 500),
    company: String(source?.company || '').slice(0, 500), secondaries: terms(source?.secondaries), lsi: terms(source?.lsi) };
  const doc = readCleanupDocument(body.document);
  const category = Number(body.category);
  const language = body.language as 'ar' | 'en';
  const analysis = runDuplicateAnalysis(doc.textBetween(0, doc.content.size, '\n\n', '\uFFFC'), keywords, 0, language);
  const phrases = analysis.duplicateAnalysis[category as keyof typeof analysis.duplicateAnalysis] || [];
  const snapshot = collectCleanupSnapshot(doc, phrases, category, language);
  return { version: 1, category, language, title: String(body.title || '').slice(0, 1000),
    document: body.document as Record<string, unknown>, keywords, snapshot };
}
