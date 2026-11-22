export function sourceLineFacts(source) {
  if (source === null || source.includes('\0')) return { lines: null, generated: false };
  let lines = source.length > 0 && !source.endsWith('\n') ? 1 : 0;
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lines += 1;
  return { lines, generated: source.includes('simt:generated') };
}
