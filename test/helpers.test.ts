/** Phase 5 — server-side helpers: markdown reduction, link extraction, fill_form. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { htmlToMarkdown } from '../src/mcp/markdown-extract';
import { extractLinks, fillForm, readAsMarkdown } from '../src/mcp/helpers';
import { StubExecutor } from '../src/executor/stub-executor';
import type { Executor, Target } from '../src/executor/types';

test('htmlToMarkdown converts headings, lists, links, emphasis; drops chrome', () => {
  const html = `
    <nav>SKIP NAV</nav>
    <h1>Title</h1>
    <p>Some <strong>bold</strong> and <em>italic</em>.</p>
    <ul><li>one</li><li>two</li></ul>
    <a href="https://example.com">Example</a>
    <script>SKIP SCRIPT</script>`;
  const md = htmlToMarkdown(html);
  assert.match(md, /# Title/);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /_italic_/);
  assert.match(md, /- one/);
  assert.match(md, /\[Example\]\(https:\/\/example\.com\)/);
  assert.ok(!md.includes('SKIP NAV'));
  assert.ok(!md.includes('SKIP SCRIPT'));
});

test('extractLinks falls back to HTML parsing when eval is unavailable', async () => {
  // StubExecutor.eval returns a non-array, so extractLinks parses getHtml.
  const ex = new StubExecutor({ activeUrl: 'https://example.com' });
  const { links } = await extractLinks(ex, {});
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(links[0].text, 'Example');
});

test('readAsMarkdown reduces the page HTML', async () => {
  const ex = new StubExecutor();
  const md = await readAsMarkdown(ex, {});
  assert.match(md, /\[Example\]\(https:\/\/example\.com\)/);
});

test('fillForm fills each field then clicks submit', async () => {
  const calls: string[] = [];
  const fake = {
    async fill(t: Target, value: string) {
      calls.push(`fill ${(t as { selector: string }).selector}=${value}`);
      return { ok: true } as const;
    },
    async click(t: Target) {
      calls.push(`click ${(t as { selector: string }).selector}`);
      return { ok: true } as const;
    },
  } as unknown as Executor;

  const out = await fillForm(fake, {
    fields: { '#email': 'a@b.com', '#name': 'Ada' },
    submitSelector: '#go',
  });
  assert.equal(out.filled, 2);
  assert.equal(out.submitted, true);
  assert.deepEqual(calls, ['fill #email=a@b.com', 'fill #name=Ada', 'click #go']);
});
