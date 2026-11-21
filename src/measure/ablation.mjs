// Read-only ablation grammar and threshold, shared by `compare --learn` and the optional
// bench. The comparison report reads stored ablation rows without loading the bench package,
// so the arm-name parser and the deletion threshold cannot live only behind that package.

/** How close to zero a rule's recall change must be before its cost decides deletion. */
export const DEL_R_TOLERANCE = 0.01;

/**
 * Parse an ablation arm name (`no-core-<slug>`, `no-profile-<id>`, `no-process-<id>`)
 * or return null when `armName` is not an ablation arm.
 */
export function parseAblationArmName(armName) {
  const s = String(armName ?? '').trim();
  if (s.startsWith('no-core-') && s.length > 'no-core-'.length) {
    const slug = s.slice('no-core-'.length);
    return {
      name: s,
      kind: 'ablate',
      base: 'current',
      ablate: { kind: 'core', targetId: slug, sectionId: `core:${slug}` },
    };
  }
  if (s.startsWith('no-profile-') && s.length > 'no-profile-'.length) {
    const id = s.slice('no-profile-'.length);
    return {
      name: s,
      kind: 'ablate',
      base: 'current',
      ablate: { kind: 'profile', targetId: id, sectionId: `profile:${id}` },
    };
  }
  if (s.startsWith('no-process-') && s.length > 'no-process-'.length) {
    const id = s.slice('no-process-'.length);
    return {
      name: s,
      kind: 'ablate',
      base: 'current',
      ablate: { kind: 'process', targetId: id, sectionId: `process:${id}` },
    };
  }
  return null;
}
