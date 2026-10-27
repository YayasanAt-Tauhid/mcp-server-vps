export const DISPLAY_MODES = {
  desktop: { mode: 'desktop', width: 1366, height: 768, mobile: false, touch: false },
  mobile: { mode: 'mobile', width: 390, height: 690, mobile: true, touch: true }
};

export function displayConfig(mode, dimensions = {}) {
  if (!DISPLAY_MODES[mode]) throw new Error('mode harus desktop atau mobile');
  const config = { ...DISPLAY_MODES[mode] };
  if (mode === 'mobile') {
    for (const [key, min, max] of [['width', 320, 640], ['height', 320, 768]]) {
      if (dimensions[key] === undefined) continue;
      const value = Number(dimensions[key]);
      if (!Number.isFinite(value)) throw new Error('Ukuran layar tidak valid');
      config[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  return config;
}

export function parseDisplayState(raw) {
  try {
    const state = JSON.parse(raw);
    return displayConfig(state.mode, state);
  } catch {
    return displayConfig(String(raw).trim() === 'mobile' ? 'mobile' : 'desktop');
  }
}
