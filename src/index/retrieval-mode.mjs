export function retrievalMode(value) {
  if (value === undefined) return 'v1';
  return value === 'v1' || value === 'v2' ? value : null;
}
