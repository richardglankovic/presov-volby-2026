import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'site');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function sourceFiles(directory, prefix = '') {
  const files = new Map();
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const [key, value] of await sourceFiles(resolve(directory, entry.name), name + '/')) files.set(key, value);
    } else {
      let bytes = await readFile(resolve(directory, entry.name));
      if (/\.(html|css|js|mjs|json|geojson|svg|txt)$/.test(name)) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
      files.set(name, bytes);
    }
  }
  return files;
}

export async function compileRelease() {
  const sources = await sourceFiles(source);
  const hashes = [...sources].map(([name, bytes]) => `${name}:${digest(bytes)}`);
  for (const path of ['scripts/build_site.mjs', 'package-lock.json']) hashes.push(digest((await readFile(resolve(root, path), 'utf8')).replace(/\r\n/g, '\n')));
  const version = digest(hashes.join('\n')).slice(0, 12);
  const entry = `app.${version}.js`;
  const styles = `styles.${version}.css`;
  const settings = { bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', charset: 'utf8', legalComments: 'inline' };
  const app = await build({ ...settings, entryPoints: [resolve(source, 'app.js')], outfile: resolve(root, 'dist', entry), external: ['./vendor/*'], define: { __APP_RELEASE__: JSON.stringify(version) } });
  const loader = await build({ ...settings, entryPoints: [resolve(source, 'entry.js')], outfile: resolve(root, 'dist', 'loader.js'), minify: true, define: { __APP_RELEASE__: JSON.stringify(version), __APP_ENTRY__: JSON.stringify('./' + entry) } });
  const files = new Map(sources);
  files.delete('entry.js');
  files.delete('recovery.js');
  files.set(entry, app.outputFiles[0].contents);
  files.set(styles, sources.get('styles.css'));
  // Keep the unversioned compatibility entry for HTML cached before versioning.
  files.set('app.js', Buffer.from(`import './${entry}';\n`));
  for (const [name, bytes] of sources) if (name.startsWith('data/')) files.set(`data/${version}/${name.slice(5)}`, bytes);
  const html = sources.get('index.html').toString('utf8')
    .replace('name="app-release" content="development"', `name="app-release" content="${version}"`)
    .replace('href="./styles.css"', `href="./${styles}"`)
    .replace(/href="\.\/data\//g, `href="./data/${version}/`)
    .replace('<script type="module" src="./app.js"></script>', `<script type="module">${loader.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
  files.set('index.html', Buffer.from(html));
  const manifest = { version, entry, styles, dataPrefix: `data/${version}/`, files: Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)])) };
  files.set('release.json', Buffer.from(JSON.stringify(manifest)));
  return { files, manifest };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { files, manifest } = await compileRelease();
  const output = resolve(root, 'dist');
  for (const [name, bytes] of files) {
    const path = resolve(output, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  console.log(`Built release ${manifest.version}: ${files.size} public files in dist/`);
}
