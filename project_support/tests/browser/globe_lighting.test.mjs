import test from 'node:test';
import assert from 'node:assert/strict';
import { applyGlobeLighting, bindLightingToggle, lightingPreference, saveLightingPreference } from '../../../user_application/web/scripts/orbit/globe_lighting.js';

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
}

function fakeGlobe(theme = 'dark') {
  const globe = {
    theme, satelliteEmphasis: true, styled: 0, rendered: 0,
    viewer: { scene: { globe: { enableLighting: true, dynamicAtmosphereLighting: true }, requestRender() { globe.rendered += 1; } } },
    applyImageryStyle() { globe.styled += 1; },
  };
  return globe;
}

function fakeButton() {
  const attributes = new Map();
  const handlers = new Map();
  return {
    title: '', attributes,
    setAttribute(name, value) { attributes.set(name, value); },
    addEventListener(type, handler) { handlers.set(type, handler); },
    click() { handlers.get('click')?.(); },
  };
}

class FakeWindow {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; }
}
globalThis.CustomEvent ??= class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };

test('turning shading off lights the whole globe at the sunlit level without brightening the imagery', () => {
  const globe = fakeGlobe('dark');
  assert.equal(applyGlobeLighting(globe, false), false);
  assert.equal(globe.viewer.scene.globe.enableLighting, false);
  assert.equal(globe.viewer.scene.globe.dynamicAtmosphereLighting, false);
  assert.equal(globe.satelliteEmphasis, true, 'the dimmed day-side imagery style is kept for the whole globe');
  assert.equal(globe.styled, 0, 'the imagery style is not re-applied, so "off" cannot read brighter than day');
  assert.equal(globe.rendered, 1);
  assert.equal(applyGlobeLighting(globe, true), true);
  assert.equal(globe.viewer.scene.globe.enableLighting, true);
  assert.equal(globe.satelliteEmphasis, true);
  assert.equal(applyGlobeLighting(null, true), true, 'no globe yet is not an error');
});

test('the light theme never shades even when shading is requested', () => {
  const globe = fakeGlobe('light');
  applyGlobeLighting(globe, true);
  assert.equal(globe.viewer.scene.globe.enableLighting, false);
  assert.equal(globe.satelliteEmphasis, true, 'the imagery emphasis is untouched by the toggle');
});

test('the preference defaults to shading on and survives a corrupt or missing store', () => {
  const storage = new FakeStorage();
  assert.equal(lightingPreference(storage), true);
  saveLightingPreference(false, storage);
  assert.equal(lightingPreference(storage), false);
  assert.equal(lightingPreference(null), true);
  assert.equal(lightingPreference({ getItem() { throw new Error('blocked'); } }), true);
});

test('two toolbar buttons stay in step through the window event and apply to their own globes', () => {
  const storage = new FakeStorage();
  const target = new FakeWindow();
  const dashboardGlobe = fakeGlobe();
  const nodeGlobe = fakeGlobe();
  const dashboardButton = fakeButton();
  const nodeButton = fakeButton();
  const dashboard = bindLightingToggle(dashboardButton, () => dashboardGlobe, { storage, target });
  const listeners = new Map(target.listeners);
  // A second binding on the same fake window replaces the listener map entry, so chain them by hand.
  const node = bindLightingToggle(nodeButton, () => nodeGlobe, { storage, target: { addEventListener: (type, handler) => listeners.set(`${type}:node`, handler), dispatchEvent: event => { for (const handler of listeners.values()) handler(event); return true; } } });
  assert.equal(dashboardButton.attributes.get('aria-pressed'), 'true');
  assert.equal(nodeButton.attributes.get('aria-pressed'), 'true');
  nodeButton.click();
  assert.equal(node.enabled, false);
  assert.equal(nodeGlobe.viewer.scene.globe.enableLighting, false);
  assert.equal(lightingPreference(storage), false, 'the choice is stored for the next session');
  assert.equal(dashboard.enabled, false, 'the dashboard button follows the event');
  assert.equal(dashboardButton.attributes.get('aria-pressed'), 'false');
  assert.equal(dashboardGlobe.viewer.scene.globe.enableLighting, false);
  assert.ok(dashboardButton.title.includes('켜기'));
  dashboardGlobe.viewer.scene.globe.enableLighting = true; // setTheme() resets the flags
  dashboard.apply();
  assert.equal(dashboardGlobe.viewer.scene.globe.enableLighting, false, 're-applying after a theme change reuses the stored state');
  assert.equal(dashboardGlobe.rendered, 2);
});

test('three maps share shading even when node and communication maps are opened later', () => {
  const storage = new FakeStorage();
  const listeners = [];
  const target = { addEventListener: (_, listener) => listeners.push(listener), dispatchEvent: event => listeners.forEach(listener => listener(event)) };
  const globes = [fakeGlobe(), fakeGlobe(), fakeGlobe()];
  const buttons = [fakeButton(), fakeButton(), fakeButton()];
  bindLightingToggle(buttons[0], () => globes[0], { storage, target });
  buttons[0].click();
  for (const i of [1, 2]) bindLightingToggle(buttons[i], () => globes[i], { storage, target }).apply();
  assert.deepEqual(globes.map(globe => globe.viewer.scene.globe.enableLighting), [false, false, false]);
  assert.deepEqual(buttons.map(button => button.attributes.get('aria-pressed')), ['false', 'false', 'false']);
  buttons[2].click();
  assert.deepEqual(globes.map(globe => globe.viewer.scene.globe.enableLighting), [true, true, true]);
  buttons[1].click();
  const reopened = fakeGlobe();
  bindLightingToggle(fakeButton(), reopened, { storage, target }).apply();
  assert.equal(reopened.viewer.scene.globe.enableLighting, false, 'reopening the app retains the selected display preference');
});
