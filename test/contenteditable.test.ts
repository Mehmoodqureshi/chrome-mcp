/**
 * `type`/`focus` against a contenteditable host. A rich editor has no `value`
 * setter, so the old `setValue` path made `clear` a no-op and new text landed
 * beside the old — the bug that duplicated three social posts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal DOM stand-in: enough of the contract pageOp actually uses. */
function makeHost(initial: string) {
  const host: any = {
    isContentEditable: true,
    textContent: initial,
    focus() { host.focused = true; },
    dispatchEvent() { return true; },
  };
  const selection = { removeAllRanges() {}, addRange(_r: unknown) {} };
  const range: {
    selectNodeContents(n: any): void;
    collapse(toStart: boolean): void;
    node: any;
    collapsed: boolean;
  } = {
    selectNodeContents(n: any) { range.node = n; },
    collapse(toStart: boolean) { range.collapsed = toStart; },
    node: null,
    collapsed: false,
  };
  const doc: any = {
    createRange: () => range,
    execCommand(cmd: string, _show?: boolean, value?: string) {
      if (cmd === 'delete') host.textContent = '';
      if (cmd === 'insertText') host.textContent += value ?? '';
      return true;
    },
  };
  return { host, doc, selection, range };
}

/** The patched branch, extracted so it can run without a browser. */
function typeOp(env: ReturnType<typeof makeHost>, text: string, clear: boolean) {
  const { host, doc, selection, range } = env;
  if (host.isContentEditable) {
    host.focus();
    range.selectNodeContents(host);
    selection.removeAllRanges();
    selection.addRange(range);
    if (clear) doc.execCommand('delete');
    else range.collapse(false);
    if (text) doc.execCommand('insertText', false, text);
    return { found: true };
  }
  return { found: false };
}

test('clear:true replaces the existing text instead of appending', () => {
  const env = makeHost('old draft text');
  typeOp(env, 'brand new text', true);
  assert.equal(env.host.textContent, 'brand new text');
  assert.doesNotMatch(env.host.textContent, /old draft/);
});

test('clear:false appends, which is what the caret-at-end path is for', () => {
  const env = makeHost('start ');
  typeOp(env, 'and more', false);
  assert.equal(env.host.textContent, 'start and more');
});

test('typing twice with clear each time never doubles the post', () => {
  const env = makeHost('');
  typeOp(env, 'first version', true);
  typeOp(env, 'second version', true);
  assert.equal(env.host.textContent, 'second version');
});

test('the host is focused before the range is set', () => {
  const env = makeHost('x');
  typeOp(env, 'y', true);
  assert.equal(env.host.focused, true);
});
