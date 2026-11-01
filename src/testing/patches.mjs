// Which files a unified diff touches.
//
// A patch is read from its destination side (`b/`), because the destination is the file
// that exists after the change; a deletion names `/dev/null` and contributes no path.
// The grader uses it to measure the blast radius, and the skills compiler uses it to ask
// which files a stored run touched — neither should have to import the bench's grader to
// read a diff header.

/**
 * Extract repository-relative file paths touched by a unified git diff.
 *
 * @param {Buffer|string} patch
 * @returns {string[]} sorted, unique paths
 */
export function extractPatchFiles(patch) {
  const text = Buffer.isBuffer(patch) ? patch.toString('utf8') : String(patch ?? '');
  const files = new Set();
  for (const line of text.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.add(match[2]);
  }
  return [...files].sort();
}
