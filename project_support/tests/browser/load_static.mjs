import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Loads a browser module for node:test by rewriting the served /static/* and relative imports of
// the whole module graph to data URLs. One data URL per source file, so modules that share a
// dependency share its instance exactly as they do in the browser.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const STATIC_ROOTS = {
  '/static/model_library/': 'digital_twin/model_library/browser/',
  '/static/simulation/': 'digital_twin/simulation/browser/',
  '/static/visualization/': 'digital_twin/visualization/',
  '/static/verification/': 'digital_twin/verification/browser/',
  '/static/communication/': 'communication/browser/',
  '/static/scripts/': 'user_application/web/scripts/',
};
const cache = new Map();

function resolveSpecifier(specifier, fromFile) {
  const bare = specifier.replace(/\?.*$/, '');
  for (const [prefix, folder] of Object.entries(STATIC_ROOTS)) {
    if (bare.startsWith(prefix)) return path.join(root, folder, bare.slice(prefix.length));
  }
  if (bare.startsWith('./') || bare.startsWith('../')) return path.resolve(path.dirname(fromFile), bare);
  return null;
}

export async function moduleUrl(relativePath) {
  const file = path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath);
  const key = path.normalize(file);
  if (cache.has(key)) return cache.get(key);
  // Register a placeholder first so a cycle cannot recurse forever; cycles are not expected.
  cache.set(key, null);
  let source = await readFile(file, 'utf8');
  const specifiers = [...source.matchAll(/from\s+(["'])([^"']+)\1/g)].map(match => match[2]);
  for (const specifier of new Set(specifiers)) {
    const target = resolveSpecifier(specifier, file);
    if (!target) continue;
    const url = await moduleUrl(target);
    source = source.split(`from "${specifier}"`).join(`from "${url}"`).split(`from '${specifier}'`).join(`from '${url}'`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  cache.set(key, url);
  return url;
}

export async function loadStatic(relativePath) {
  return import(await moduleUrl(relativePath));
}

export const fileUrl = relativePath => pathToFileURL(path.join(root, relativePath)).href;
