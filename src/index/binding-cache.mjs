import { readSqliteRows } from './persist.mjs';

export async function readBindingRows(root) {
  const { rows, error } = await readSqliteRows(root,
    `select path, lang, json_extract(props, '$.bindings') as bindings
      from sources where kind = 'blob' order by path`);
  return {
    files: rows.map(({ path, lang, bindings }) => ({
      path, lang,
      ...(bindings === null ? { namedImports: [], reexports: [], available: false } : { ...JSON.parse(bindings), available: true }),
    })),
    error,
  };
}
