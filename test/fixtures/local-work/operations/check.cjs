const { readFileSync } = require('node:fs');

const files = ['handbook/current.md', 'handbook/archive.md'];
for (const file of files) {
  const document = readFileSync(file, 'utf8');
  const reviewed = /value=(\d+) unit=days status=reviewed/.exec(document);
  if (!document.includes('# Device checkout') || reviewed === null ||
      !document.includes(`retention is ${reviewed[1]} days.`)) process.exitCode = 1;
}
process.stdout.write(`simt checked: ${files.length}\n`);
