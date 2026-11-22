/** Keep flat findings and attach links only where multiple findings share a proven cause. */
export function withFindingCauses(findings) {
  const sizes = new Map();
  for (const { cause } of findings) {
    if (cause) sizes.set(cause.id, (sizes.get(cause.id) ?? 0) + 1);
  }
  const seen = new Set();
  return findings.map((finding) => {
    const { cause, ...row } = finding;
    if (!cause || sizes.get(cause.id) < 2) return row;
    if (seen.has(cause.id)) return { ...row, causedBy: cause.id };
    seen.add(cause.id);
    return { ...row, rootCause: cause };
  });
}
