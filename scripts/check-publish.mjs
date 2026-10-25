import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), failures = [];
const forbiddenPath = /(?:^|\/)(?:node_modules|state|\.data|\.env(?:\..*)?|admin-token|agent-token|credentials\.json|cookies\.json)(?:\/|$)|\.(?:log|bak|tgz)$/;
const patterns = [
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['credential token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/],
  ['personal home path', /\/(?:Users|home)\/[A-Za-z0-9._-]+\//],
  ['credential URL', /https?:\/\/[^/\s:@]+:[^/\s:@]+@/],
];
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = prefix + e.name;
    if (['node_modules', '.git'].includes(e.name)) return [];
    if (e.isSymbolicLink()) throw new Error('Source symlinks must not be published: ' + rel);
    return e.isDirectory() ? walk(path.join(dir, e.name), rel + '/') : [rel];
  });
}
const files = result.status === 0 ? result.stdout.split('\0').filter(Boolean) : walk(root);
for (const file of files) {
  if (forbiddenPath.test(file)) { failures.push(file + ': private/runtime path'); continue; }
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const [name, pattern] of patterns) if (pattern.test(text)) failures.push(file + ': ' + name);
}
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
for (const file of packed.files) if (forbiddenPath.test(file.path)) failures.push(file.path + ': forbidden package content');
for (const required of ['lib/index.js', 'lib/runtime.js', 'bin/cli.js', 'bin/mcp.js', 'bin/qq-mcp.js', 'cordis.patch.yml', 'public/index.html', 'KNOWN_ISSUES.md', 'LICENSE']) {
  if (!packed.files.some(x => x.path === required)) failures.push(required + ': missing package entry');
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`PASS ${files.length} source files and ${packed.files.length} package entries; no runtime data or credential patterns found`);
