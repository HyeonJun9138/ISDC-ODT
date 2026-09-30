// Sun-direction shading toggle shared by all three map views. With shading on, the
// globe darkens the night side from the Sun direction; with it off the whole Earth is lit at the
// same level as the sunlit side (the imagery style is left alone, so "off" is never brighter than
// day). The choice is a per-browser display preference kept in localStorage and mirrored between
// globes through a window event, including a view opened later in the session.
const STORAGE_KEY = "spacetwin-globe-lighting-v1";
const EVENT = "spacetwin:globelighting";
const LABELS = {
  on: "해 방향 음영 끄기: 지구 전체를 해가 비추는 쪽과 같은 밝기로 봅니다",
  off: "해 방향 음영 켜기: 해 방향에 따라 밤 쪽을 어둡게 표시합니다",
};

export function lightingPreference(storage = globalThis.localStorage) {
  try { return storage?.getItem(STORAGE_KEY) !== "off"; } catch { return true; }
}

export function saveLightingPreference(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, enabled ? "on" : "off"); } catch { /* session-only preference */ }
}

// Apply shading to a GlobeController. Light theme never shades, so the flag is combined with the
// theme. Only the lighting flags change: the imagery emphasis (dimmed, high-contrast tiles) is left
// as it is, so the unshaded globe looks like the daylit side everywhere instead of a brighter,
// fully saturated map.
export function applyGlobeLighting(globe, enabled) {
  const shaded = enabled !== false;
  if (!globe) return shaded;
  const scene = globe.viewer?.scene;
  if (scene?.globe) {
    const light = globe.theme === "light";
    scene.globe.enableLighting = shaded && !light;
    scene.globe.dynamicAtmosphereLighting = shaded && !light;
  }
  scene?.requestRender?.();
  return shaded;
}

// Wire a toolbar button (aria-pressed = shading on) to a globe provider. Returns { apply, enabled }
// so the owner can re-apply after theme changes, which reset the globe's lighting flags.
export function bindLightingToggle(button, globeProvider, { storage = globalThis.localStorage, target = globalThis.window } = {}) {
  let enabled = lightingPreference(storage);
  const render = () => {
    if (!button) return;
    button.setAttribute("aria-pressed", String(enabled));
    button.title = enabled ? LABELS.on : LABELS.off;
    button.setAttribute("aria-label", enabled ? LABELS.on : LABELS.off);
  };
  const apply = () => applyGlobeLighting(typeof globeProvider === "function" ? globeProvider() : globeProvider, enabled);
  button?.addEventListener("click", () => {
    enabled = !enabled;
    saveLightingPreference(enabled, storage);
    render(); apply();
    target?.dispatchEvent?.(new CustomEvent(EVENT, { detail: { enabled, source: button } }));
  });
  target?.addEventListener?.(EVENT, event => {
    if (event.detail?.source === button) return;
    enabled = event.detail?.enabled !== false;
    render(); apply();
  });
  render();
  return { apply, get enabled() { return enabled; } };
}
