import { readFile } from 'node:fs/promises';

// Resolve only the browser URL boundary; the globe and camera code stay real.
export async function loadGlobe() {
  const file = new URL('../../../digital_twin/visualization/globe.js', import.meta.url);
  const source = (await readFile(file, 'utf8')).replace(/from (["'])([^"']+)\1/g, (_, quote, path) => {
    const target = path.startsWith('/static/simulation/')
      ? new URL(`../simulation/browser/${path.slice('/static/simulation/'.length)}`, file)
      : new URL(path, file);
    return `from ${quote}${target.href}${quote}`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
