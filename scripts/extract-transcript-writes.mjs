import fs from 'node:fs';

const transcriptPath = process.argv[2];
const outDir = process.argv[3];
const needles = (process.argv[4] || '').split(',').filter(Boolean);

const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
const latest = new Map();

for (const line of lines) {
  if (!line.includes('"Write"')) continue;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }
  const tu = o.message?.content?.find((c) => c.type === 'tool_use' && c.name === 'Write');
  if (!tu?.input?.path || !tu?.input?.contents) continue;
  const path = tu.input.path.replace(/\\/g, '/');
  if (needles.length && !needles.some((n) => path.includes(n))) continue;
  latest.set(path, tu.input.contents);
}

fs.mkdirSync(outDir, { recursive: true });
for (const [path, contents] of latest) {
  const name = path.split('/').pop();
  const out = `${outDir}/${name}`;
  fs.writeFileSync(out, contents);
  console.log('wrote', out, contents.length);
}
