import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGE_SIZE, paginate } from '../src/mcp/paginate.mjs';

const items = (n) => Array.from({ length: n }, (_, i) => `item-${i}`);

test('a list that fits arrives whole, with no cursor to follow', () => {
  const page = paginate(items(3), undefined);
  assert.deepEqual(page.items, items(3));
  assert.equal(page.nextCursor, null);
});

test('a cursor walks the list once, in order, and then stops', () => {
  // The failure this prevents is a client that follows a cursor forever, or one that
  // sees item 0 twice because the next cursor pointed back at the page it just read.
  const all = items(PAGE_SIZE * 2 + 7);
  const seen = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const page = paginate(all, cursor);
    assert.ok(page, 'a cursor this server issued must be accepted');
    seen.push(...page.items);
    pages += 1;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    assert.ok(pages < 10, 'pagination did not terminate');
  }
  assert.deepEqual(seen, all);
  assert.equal(pages, 3);
});

test('a cursor this server did not issue is refused, not clamped', () => {
  // Clamping would answer a stale cursor with the tail and look like progress; refusing
  // says the list moved, which is the fact the client needs.
  for (const cursor of ['nope', '-1', '1.5', '0x10', ' ']) {
    assert.equal(paginate(items(10), cursor), null, `accepted ${JSON.stringify(cursor)}`);
  }
});

test('an empty list is a page with no cursor', () => {
  assert.deepEqual(paginate([], undefined), { items: [], nextCursor: null });
});

test('the protocol refuses a cursor it did not issue, and answers the first page without one', async () => {
  // The unit test proves the page arithmetic; this proves the four list methods actually
  // pass the cursor through, which is the half a client depends on.
  const { handle } = await import('../src/mcp/server.mjs');
  const { TOOLS } = await import('../src/mcp/tools.mjs');
  const request = (extra) => ({ jsonrpc: '2.0', id: 1, method: 'tools/list', ...extra });

  const refused = await handle(request({ params: { cursor: 'nope' } }), TOOLS);
  assert.equal(refused.error.code, -32602);

  const first = await handle(request({}), TOOLS);
  assert.ok(Array.isArray(first.result.tools) && first.result.tools.length > 0);
  assert.equal('nextCursor' in first.result, false, 'a complete list must not tell the client to ask again');
});
