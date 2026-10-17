import fs from 'fs';
import path from 'path';

function scan(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === '.next') continue;
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(scan(full));
    } else {
      try {
        const content = fs.readFileSync(full, 'utf8');
        const lines = content.split('\n');
        lines.forEach((l, idx) => {
          if (/chatify/i.test(l)) {
            results.push({ file: full.replace(/\\/g, '/'), line: idx + 1, content: l.trim() });
          }
        });
      } catch (e) {}
    }
  }
  return results;
}

const matches = scan('src/app');
for (const m of matches) {
  console.log(`${m.file}:${m.line} -> ${m.content}`);
}
