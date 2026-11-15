// One page of a list result, and the cursor that asks for the next one.
//
// MCP lets a server answer a list method in pages, and a client that ignores `nextCursor`
// must still see a usable first page. This server has never paginated, which was fine
// while every list fit in one reply and stops being fine the moment a workspace brings
// dozens of repositories into `resources/list`: a client that renders what it is given
// then silently shows a subset of the estate.
//
// The cursor is the offset, rendered as a string. The specification calls it opaque, and
// the client must not parse it, but it has to be stable across calls: an index into a list
// that is rebuilt in a deterministic order is, and a hash of the last item's name is not -
// two items can share one.

/** How many entries one reply carries. */
export const PAGE_SIZE = 50;

/**
 * The page a cursor asks for, or `null` when the cursor is not one this server issued.
 *
 * A cursor outside the list is not clamped to the last page: a client that walked past the
 * end has a stale cursor, and silently repeating the tail hides that the list changed
 * under it.
 */
export function paginate(items, cursor, size = PAGE_SIZE) {
  const text = cursor === undefined || cursor === null || cursor === '' ? '0' : String(cursor);
  // Only the shape this server writes: a decimal offset. `Number` accepts '0x10' and ' ',
  // and accepting a cursor nobody issued is how pagination silently repeats or skips.
  if (!/^\d+$/.test(text)) return null;
  const start = Number(text);
  // A cursor past the end is stale, not a request for the last page: `server.mjs` maps
  // `null` to the invalid-cursor error instead of silently repeating the tail. Cursor 0
  // on an empty list is still a valid empty page.
  if (start !== 0 && start >= items.length) return null;
  const page = items.slice(start, start + size);
  const next = start + size < items.length ? String(start + size) : null;
  return { items: page, nextCursor: next };
}
