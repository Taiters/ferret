import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Update .claude-plugin/plugin.json
const pluginPath = join(root, '.claude-plugin/plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
plugin.version = version;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
console.log(`Updated .claude-plugin/plugin.json → ${version}`);

// Update src/ferret.ts
const ferretPath = join(root, 'src/ferret.ts');
const ferret = readFileSync(ferretPath, 'utf8');
const pattern = /\.version\("[^"]*"\)/;
if (!pattern.test(ferret)) {
  console.error('Error: Could not find .version("...") pattern in src/ferret.ts');
  process.exit(1);
}
const updated = ferret.replace(pattern, '.version("' + version + '")');
writeFileSync(ferretPath, updated);
console.log(`Updated src/ferret.ts → ${version}`);
