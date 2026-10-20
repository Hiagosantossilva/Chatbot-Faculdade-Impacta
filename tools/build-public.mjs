import { cp, mkdir } from 'node:fs/promises';

await mkdir('public', { recursive: true });
for (const file of ['index.html', 'scripts.js', 'Design']) {
  await cp(file, `public/${file}`, { recursive: true });
}
console.log('Frontend gerado em public/ (somente HTML, JavaScript, CSS e imagens).');
