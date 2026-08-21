/**
 * Applies the user's accent color to the app by overriding the brand CSS
 * variables on <html>. The `@theme` block in index.css defines the default
 * amber ramp; runtime overrides here let the Settings appearance picker
 * re-theme every `brand-*` utility (buttons, links, nodes, glows) instantly.
 */

const DEFAULT_ACCENT = '#FEB05D';

/** Normalizes a hex color (#rgb or #rrggbb), falling back to the default. */
export function normalizeAccent(hex: string): string {
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(hex)) {
    return hex.toLowerCase();
  }
  return DEFAULT_ACCENT;
}

/** Converts a #rrggbb hex color to HSV (h: 0-360, s/v: 0-1). */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = normalizeAccent(hex);
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** Converts HSV back to a #rrggbb hex string. */
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const to = (v2: number) => Math.round((v2 + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Converts a #rrggbb hex color to an RGB tuple (0-255). */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = normalizeAccent(hex);
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

/** Converts an RGB tuple (0-255) to a #rrggbb hex string. */
export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Converts a #rrggbb hex color to HSL (h: 0-360, s/l: 0-100). */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

/** Converts HSL (h: 0-360, s/l: 0-100) to a #rrggbb hex string. */
export function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  if (sn === 0) {
    const v = Math.round(ln * 255);
    return rgbToHex(v, v, v);
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hue2rgb = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return rgbToHex(hue2rgb(hn + 1 / 3) * 255, hue2rgb(hn) * 255, hue2rgb(hn - 1 / 3) * 255);
}

/** Converts a hex color to an rgba() string with the given alpha (0..1). */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Blends a hex color toward another by ratio (0 = unchanged, 1 = target).
 * Used to derive lighter/darker shades from a base color (graph nodes, etc.).
 */
export function mixHex(hex: string, target: string, ratio: number): string {
  const a = hexToRgb(normalizeAccent(hex));
  const b = hexToRgb(normalizeAccent(target));
  const mix = (x: number, y: number) => Math.round(x + (y - x) * Math.min(1, Math.max(0, ratio)));
  return rgbToHex(mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b));
}

/**
 * Overrides the full brand ramp on :root so every `brand-*` utility follows
 * the selected accent. Lighter shades mix toward white, darker toward black.
 * `hoverGlow` optionally re-tints the button-hover underglow separately.
 */
export function applyAccentColor(hex: string, opts?: { hoverGlow?: string }): void {
  const root = document.documentElement.style;
  const accent = normalizeAccent(hex);
  const glow = opts?.hoverGlow ? normalizeAccent(opts.hoverGlow) : accent;

  root.setProperty('--color-brand-500', accent);
  root.setProperty('--color-brand-400', `color-mix(in srgb, ${accent} 85%, white)`);
  root.setProperty('--color-brand-300', `color-mix(in srgb, ${accent} 70%, white)`);
  root.setProperty('--color-brand-200', `color-mix(in srgb, ${accent} 55%, white)`);
  root.setProperty('--color-brand-100', `color-mix(in srgb, ${accent} 40%, white)`);
  root.setProperty('--color-brand-50', `color-mix(in srgb, ${accent} 25%, white)`);
  root.setProperty('--color-brand-600', `color-mix(in srgb, ${accent} 88%, black)`);
  root.setProperty('--color-brand-700', `color-mix(in srgb, ${accent} 75%, black)`);
  root.setProperty('--color-brand-800', `color-mix(in srgb, ${accent} 62%, black)`);
  root.setProperty('--color-brand-900', `color-mix(in srgb, ${accent} 48%, black)`);
  root.setProperty('--color-brand-950', `color-mix(in srgb, ${accent} 34%, black)`);
  // Translucent brand tints used for glows and active borders.
  root.setProperty('--color-brand-glow', hexToRgba(glow, 0.15));
  root.setProperty('--color-border-active', hexToRgba(glow, 0.4));
  // Hover underglow on buttons/sliders (0.35 soft glow, 0.45 pressed).
  root.setProperty('--color-hover-glow', hexToRgba(glow, 0.35));
  root.setProperty('--color-hover-glow-active', hexToRgba(glow, 0.45));
}
