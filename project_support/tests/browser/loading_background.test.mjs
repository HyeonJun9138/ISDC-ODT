import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../../../user_application/web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="loading-background">([\s\S]*?)<\/script>/)?.[1] || '';

test('each page load chooses one of the two backgrounds with equal probability before app startup', () => {
  for (const [draw, expected] of [[0, 1], [.4999, 1], [.5, 2], [.9999, 2]]) {
    const properties = {};
    let draws = 0;
    runInNewContext(script, {
      document: { documentElement: { style: { setProperty(name, value) { properties[name] = value; } } } },
      Math: { floor: Math.floor, random: () => { draws++; return draw; } },
    });
    assert.equal(properties['--loading-background'], `url("/static/assets/loading/loading_${expected}.png")`);
    assert.equal(draws, 1, 'Select once, not on each loading progress update');
  }
});
