import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getArticleAccessBadges,
  getArticleAccessDisplayName,
} from '../utils/articleAccessBadges.ts';

test('article access names expose only the part before @', () => {
  assert.equal(getArticleAccessDisplayName('writer@example.com', 'Writer Name'), 'writer');
  assert.equal(getArticleAccessDisplayName(null, 'previewer@internal.test'), 'previewer');
  assert.equal(getArticleAccessDisplayName(null, 'اسم المستخدم'), 'اسم المستخدم');
});

test('article access badges combine owners and explicit grants with clear roles', () => {
  const badges = getArticleAccessBadges({
    ownerId: 'owner-id',
    createdBy: 'creator-id',
    metadata: {
      n8nSettings: {
        accessRole: 'viewer',
        visibleToEmailsCsv: 'reader@example.com, owner@example.com',
      },
      visibleTo: [
        { id: 'reader-id', email: 'reader@example.com', role: 'viewer' },
        { id: 'owner-id', email: 'owner@example.com', role: 'viewer' },
      ],
    },
  }, [
    { id: 'owner-id', email: 'owner@example.com', fullName: 'Owner' },
    { id: 'creator-id', email: 'creator@example.com', fullName: 'Creator' },
  ]);

  assert.deepEqual(badges.map(({ name, role }) => ({ name, role })), [
    { name: 'owner', role: 'editor' },
    { name: 'creator', role: 'viewer' },
    { name: 'reader', role: 'viewer' },
  ]);
  assert.equal(badges.some(badge => badge.name.includes('@')), false);
});

test('dashboard cards merge access badges into the existing users field without a duplicate row', async () => {
  const dashboard = await readFile(
    new URL('../components/Dashboard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(dashboard, /getArticleAccessBadges\(remoteActivity, profiles\)/);
  assert.match(dashboard, /const ArticleAccessBadgesInline/);
  assert.match(dashboard, /<ArticleAccessUsersField[\s\S]*badges=\{articleAccessBadges\}/);
  assert.match(dashboard, /<EditableN8nUsersField[\s\S]*accessBadges=\{articleAccessBadges\}/);
  assert.match(dashboard, /المستخدمون القادرون على الوصول إلى المقالة/);
  assert.match(dashboard, /isEditor \? 'محرر' : 'معاينة'/);
  assert.doesNotMatch(dashboard, /\{articleAccessBadges\.length > 0 && \(\s*<div/);
});
