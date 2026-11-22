export function isRepositoryGlob(value) {
  return typeof value === 'string' && value.split('/').every((part) =>
    part !== '' && part !== '.' && part !== '..' && !/[?{\[\\\0]/u.test(part));
}

function listOf(value, predicate) {
  return Array.isArray(value) && value.every(predicate);
}

function layerId(value) {
  return typeof value === 'string' && /^[\w-]+$/u.test(value);
}

export function architectureProblem(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'architecture must be an object';
  if (value.layers === undefined && value.forbid === undefined) return 'architecture must declare layers or forbid';
  if (value.layers !== undefined && !listOf(value.layers, (layer) => layer && layerId(layer.id)
    && layer.paths?.length > 0 && listOf(layer.paths, isRepositoryGlob) && listOf(layer.mayImport, layerId))) {
    return 'architecture.layers must list {id, paths: repository globs, mayImport: layer ids}';
  }
  const ids = (value.layers ?? []).map(({ id }) => id);
  if (new Set(ids).size !== ids.length) return 'architecture.layers must use unique ids';
  if (value.forbid !== undefined && !listOf(value.forbid, (rule) => rule && isRepositoryGlob(rule.from)
    && isRepositoryGlob(rule.to) && (rule.transitive === undefined || typeof rule.transitive === 'boolean')
    && (rule.reason === undefined || typeof rule.reason === 'string'))) {
    return 'architecture.forbid must list {from: repository glob, to: repository glob, reason?, transitive?}';
  }
  return null;
}
