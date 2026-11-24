export function retrievalMode(value) {
  if (value === undefined) return 'v2';
  return value === 'v1' || value === 'v2' ? value : null;
}
