import fs from 'node:fs';

const transcriptPath = process.argv[2];
const outPath = process.argv[3];
const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
let best = '';

function extractEnvFromText(text) {
  const m = text.match(
    /# Arquivo gerado automaticamente[\s\S]*?(?=\n<\/user_query>|$)/
  );
  if (!m) return '';
  const block = m[0].replace(/<\/user_query>$/, '').trim();
  return block.includes('PORT=3001') ? block : '';
}

for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    continue;
  }

  const texts = [];
  if (o.role === 'user' || o.role === 'assistant') {
    for (const c of o.message?.content || []) {
      if (c.type === 'text' && c.text) texts.push(c.text);
    }
  }
  for (const text of texts) {
    const env = extractEnvFromText(text);
    if (env.length > best.length) best = env;
  }

  const tu = o.message?.content?.find(
    (c) =>
      c.type === 'tool_use' &&
      c.name === 'Write' &&
      String(c.input?.path || '').replace(/\\/g, '/').endsWith('/.env')
  );
  if (tu?.input?.contents && tu.input.contents.length > best.length) {
    best = tu.input.contents;
  }
}

if (!best) {
  console.error('No .env Write found in transcript');
  process.exit(1);
}

fs.writeFileSync(outPath, best);
console.log('restored', best.length, 'chars');
console.log(
  'DATABASE_URL',
  /DATABASE_URL=postgresql:\/\//.test(best) ? 'present' : 'missing'
);
