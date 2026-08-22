import { getCurrentWindow } from '@tauri-apps/api/window';
import { Image as TauriImage } from '@tauri-apps/api/image';
import blueAC from '../assets/logos/Blue AC.svg';
import bwAC from '../assets/logos/BW AC.svg';
import greyAC from '../assets/logos/Grey AC.svg';
import whiteAC from '../assets/logos/White AC.svg';
import blue from '../assets/logos/Blue.svg';
import grey from '../assets/logos/Grey.svg';
import white from '../assets/logos/White.svg';
import loaderBlue from '../assets/loaders/Blue.webp';
import loaderBW from '../assets/loaders/BW.webp';
import loaderGrey from '../assets/loaders/Grey.webp';
import loaderWhite from '../assets/loaders/White.webp';
import videoBlue from '../assets/loaders/Blue.mp4';
import videoBW from '../assets/loaders/BW.mp4';
import videoGrey from '../assets/loaders/Grey.mp4';
import videoWhite from '../assets/loaders/White.mp4';

/**
 * The Prism logos the user can pick from as the app icon (SVG, transparent
 * backgrounds). The rainbow set uses the AC variants; a separate no-rainbow
 * set and a monochrome (black & white) set are grouped under their own labels
 * in the settings UI. `appIcon` in settings stores the option `id`;
 * getAppIcon() resolves it.
 */
export interface AppIconOption {
  id: string;
  label: string;
  url: string;
}

export interface AppIconGroup {
  id: string;
  label: string;
  icons: AppIconOption[];
}

export const APP_ICON_GROUPS: AppIconGroup[] = [
  {
    id: 'rainbow',
    label: 'With Rainbow',
    icons: [
      { id: 'blue-ac', label: 'Blue', url: blueAC },
      { id: 'grey-ac', label: 'Grey', url: greyAC },
      { id: 'white-ac', label: 'White', url: whiteAC },
    ],
  },
  {
    id: 'no-rainbow',
    label: 'No Rainbow',
    icons: [
      { id: 'blue', label: 'Blue', url: blue },
      { id: 'grey', label: 'Grey', url: grey },
      { id: 'white', label: 'White', url: white },
    ],
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    icons: [{ id: 'bw-ac', label: 'Black & White', url: bwAC }],
  },
];

/** Flat lookup list (used by getAppIcon). */
export const APP_ICONS: AppIconOption[] = APP_ICON_GROUPS.flatMap((g) => g.icons);

/**
 * Resolves a stored app-icon id to its asset URL. Falls back to the default
 * /logo.png for empty ids, and keeps legacy data-URL uploads working.
 */
export function getAppIcon(id?: string): string {
  if (!id) return '/logo.png';
  if (id.startsWith('data:')) return id;
  return APP_ICONS.find((icon) => icon.id === id)?.url ?? '/logo.png';
}

/**
 * Animated splash loaders (mp4) keyed by the logo color they match. Blue,
 * grey and white variants (rainbow or no-rainbow) collapse onto their shared
 * color video; the monochrome black & white logo maps to the BW loader.
 */
const SPLASH_LOADERS: Record<string, string> = {
  blue: loaderBlue,
  'blue-ac': loaderBlue,
  grey: loaderGrey,
  'grey-ac': loaderGrey,
  white: loaderWhite,
  'white-ac': loaderWhite,
  'bw-ac': loaderBW,
};

/**
 * Resolves a stored app-icon id to its matching animated splash loader WebP.
 * Empty/default ids fall back to the blue loader; unknown ids and legacy
 * data-URL uploads return `undefined` so callers can show a static fallback.
 */
export function getSplashLoader(id?: string): string | undefined {
  if (!id) return loaderBlue;
  if (id.startsWith('data:')) return undefined;
  return SPLASH_LOADERS[id];
}

/**
 * H.264 mp4 variants of the splash loaders (same color mapping as the WebPs).
 * Video is hardware-decoded in WKWebView, so it plays off the main thread and
 * stays smooth where the animated WebP stutters. Used as the primary loader;
 * getSplashLoader() remains the fallback if the video fails to load/play.
 */
const SPLASH_VIDEOS: Record<string, string> = {
  blue: videoBlue,
  'blue-ac': videoBlue,
  grey: videoGrey,
  'grey-ac': videoGrey,
  white: videoWhite,
  'white-ac': videoWhite,
  'bw-ac': videoBW,
};

/** Resolves a stored app-icon id to its matching mp4 splash loader. */
export function getSplashVideo(id?: string): string | undefined {
  if (!id) return videoBlue;
  if (id.startsWith('data:')) return undefined;
  return SPLASH_VIDEOS[id];
}

/**
 * Rasterizes any resolvable icon URL (SVG, PNG, data URL, bundled asset) to
 * RGBA PNG bytes by drawing it through a canvas at a fixed size.
 */
async function rasterizeToPng(url: string, size = 256): Promise<Uint8Array> {
  const img = new window.Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load icon: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b as Blob), 'image/png')
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Applies the chosen logo as the OS window icon (taskbar on Windows, window
 * icon on macOS/Linux). Falls back silently if the runtime icon can't be set
 * (e.g. bundled builds with a locked window icon).
 */
export async function applyWindowIcon(id?: string): Promise<void> {
  try {
    const url = getAppIcon(id);
    const png = await rasterizeToPng(url);
    const icon = await TauriImage.fromBytes(png);
    await getCurrentWindow().setIcon(icon);
  } catch (err) {
    console.error('applyWindowIcon failed:', err);
  }
}
