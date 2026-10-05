import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getArticleAccessBadges,
  getArticleAssignmentRoleForUser,
  getArticleAccessDisplayName,
  isArticleAssignedToUser,
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

test('administrator access stays implicit and is never rendered as an assigned article user', () => {
  const badges = getArticleAccessBadges({
    ownerId: 'admin-id',
    assignedTo: null,
    metadata: {
      n8nSettings: {
        accessRole: 'editor',
        visibleToEmailsCsv: 'ciwan.mu90@gmail.com, writer@example.com',
      },
      visibleTo: [
        { id: 'admin-id', email: 'ciwan.mu90@gmail.com', role: 'editor' },
        { id: 'writer-id', email: 'writer@example.com', role: 'editor' },
      ],
    },
  }, [
    { id: 'admin-id', email: 'ciwan.mu90@gmail.com', fullName: 'Admin', role: 'admin' },
    { id: 'writer-id', email: 'writer@example.com', fullName: 'Writer', role: 'user' },
  ]);

  assert.deepEqual(badges.map(({ name, role }) => ({ name, role })), [
    { name: 'writer', role: 'editor' },
  ]);
});

test('the canonical administrator email remains implicit even when legacy metadata has no role', () => {
  const badges = getArticleAccessBadges({
    metadata: {
      n8nSettings: { visibleToEmailsCsv: 'ciwan.mu90@gmail.com' },
    },
  });
  assert.deepEqual(badges, []);
});

test('automation status visibility follows article assignment regardless of viewer or editor role', () => {
  const article = {
    ownerId: 'owner-id',
    createdBy: 'creator-id',
    assignedTo: null as string | null,
    metadata: {
      n8nSettings: {
        visibleToEmailsCsv: 'legacy-viewer@example.com',
      },
      visibleTo: [
        { id: 'viewer-id', email: 'viewer@example.com', role: 'viewer' },
        { id: 'editor-id', email: 'editor@example.com', role: 'editor' },
      ],
    },
  };

  assert.equal(isArticleAssignedToUser(article, { id: 'viewer-id' }), true);
  assert.equal(isArticleAssignedToUser(article, { id: 'editor-id' }), true);
  assert.equal(isArticleAssignedToUser(article, { email: 'legacy-viewer@example.com' }), true);
  assert.equal(isArticleAssignedToUser(article, { id: 'creator-id' }), true);
  assert.equal(isArticleAssignedToUser(article, { id: 'unrelated-user' }), false);
  assert.equal(getArticleAssignmentRoleForUser(article, { id: 'viewer-id' }), 'viewer');
  assert.equal(getArticleAssignmentRoleForUser(article, { id: 'editor-id' }), 'editor');
  assert.equal(getArticleAssignmentRoleForUser(article, { email: 'legacy-viewer@example.com' }), 'viewer');
  assert.equal(getArticleAssignmentRoleForUser(article, { id: 'creator-id' }), 'viewer');
});

test('dashboard cards merge access badges into the existing users field without a duplicate row', async () => {
  const dashboard = await readFile(
    new URL('../components/Dashboard.tsx', import.meta.url),
    'utf8',
  );

  assert.match(dashboard, /getArticleAccessBadges\(remoteActivity, profiles\)/);
  assert.match(dashboard, /getArticleAssignmentRoleForUser\(activity/);
  assert.match(dashboard, /showExternalAnalysisControls=\{!isTrashVisible && \(isAdmin \|\| assignedToCurrentUser\)\}/);
  assert.match(dashboard, /canManageExternalAnalysis=\{canManageExternalAnalysis\}/);
  assert.match(dashboard, /const ArticleAccessBadgesInline/);
  assert.match(dashboard, /<ArticleAccessUsersField[\s\S]*badges=\{articleAccessBadges\}/);
  assert.match(dashboard, /<EditableN8nUsersField[\s\S]*accessBadges=\{articleAccessBadges\}/);
  assert.match(dashboard, /المستخدمون القادرون على الوصول إلى المقالة/);
  assert.match(dashboard, /profile\.email && !isImplicitArticleAdministrator\(profile\)/);
  assert.match(dashboard, /tracking-wider text-gray-400[^>]*>--------<\/span>/);
  assert.match(dashboard, /const getOwnerLabel = \(article: RemoteArticleActivity\)/);
  assert.match(dashboard, /profile \? getProfileUsernameLabel\(profile\) : 'مستخدم غير معروف'/);
  assert.doesNotMatch(dashboard, /candidatesAreKnownAdmins \? '--------'/);
  assert.match(dashboard, /isEditor \? 'محرر' : 'معاينة'/);
  assert.doesNotMatch(dashboard, /\{articleAccessBadges\.length > 0 && \(\s*<div/);
});
