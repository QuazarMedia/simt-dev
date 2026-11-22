export const GIT_SHA = /^[\da-f]{40,64}$/u;

/** Parse a NUL-delimited name log whose format starts with %x00%H%x00. */
export function parseNameLog(raw, fields) {
  const commits = [];
  const tokens = raw.split('\0');
  let commit;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token && GIT_SHA.test(tokens[index + 1] ?? '')) {
      commit = { sha: tokens[index + 1], paths: [] };
      for (const [offset, field] of fields.entries()) commit[field] = tokens[index + 2 + offset];
      commits.push(commit);
      index += 1 + fields.length;
    } else if (token && commit) {
      commit.paths.push(commit.paths.length ? token : token.replace(/^\n/u, ''));
    }
  }
  return commits;
}
