import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  handleEditorLinkClick,
  resolveEditorLinkClick,
} from '../utils/editorLinkInteraction.ts';

const createLinkTarget = (href: string): EventTarget => ({
  closest: (selector: string) => selector === 'a[href]'
    ? { getAttribute: (name: string) => name === 'href' ? href : null }
    : null,
}) as unknown as EventTarget;

const createClickEvent = (href: string, ctrlKey: boolean, button = 0) => {
  let prevented = false;
  const event = {
    target: createLinkTarget(href),
    ctrlKey,
    button,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as MouseEvent;

  return {
    event,
    wasPrevented: () => prevented,
  };
};

test('regular editor link click is blocked without consuming caret handling', () => {
  const click = createClickEvent('/services', false);
  const opened: string[] = [];

  const handled = handleEditorLinkClick(click.event, {
    baseUrl: 'https://example.com/articles/current',
    openUrl: url => opened.push(url),
  });

  assert.equal(click.wasPrevented(), true);
  assert.equal(handled, false);
  assert.deepEqual(opened, []);
});

test('Ctrl plus primary click opens a safe editor link in a new tab handler', () => {
  const click = createClickEvent('/services', true);
  const opened: string[] = [];

  const handled = handleEditorLinkClick(click.event, {
    baseUrl: 'https://example.com/articles/current',
    openUrl: url => opened.push(url),
  });

  assert.equal(click.wasPrevented(), true);
  assert.equal(handled, true);
  assert.deepEqual(opened, ['https://example.com/services']);
});

test('Ctrl click rejects unsafe protocols and non-primary mouse buttons', () => {
  const unsafe = resolveEditorLinkClick(
    createLinkTarget('javascript:alert(1)'),
    true,
    0,
    'https://example.com/',
  );
  const middleClick = resolveEditorLinkClick(
    createLinkTarget('https://example.com/services'),
    true,
    1,
    'https://example.com/',
  );

  assert.deepEqual(unsafe, { isLink: true, openUrl: '' });
  assert.deepEqual(middleClick, { isLink: true, openUrl: '' });
});

test('editor stylesheet keeps linked text visibly underlined', async () => {
  const editorStyles = await readFile(new URL('../styles/editor.css', import.meta.url), 'utf8');

  assert.match(editorStyles, /\.ProseMirror a\[href\]\s*\{/);
  assert.match(editorStyles, /text-decoration-line:\s*underline\s*!important/);
  assert.match(editorStyles, /text-underline-offset:/);
});
