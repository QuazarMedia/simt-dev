export function retrievalMode(value) {
  if (value === undefined) return 'v2';
  return value === 'v1' || value === 'v2' || value === 'v3' ? value : null;
}

export function isModernRetrieval(value) {
  return value === 'v2' || value === 'v3';
}
