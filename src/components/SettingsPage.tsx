import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  hexToHsl,
  hexToHsv,
  hexToRgb,
  hslToHex,
  hsvToHex,
  rgbToHex,
} from '../utils/accentColor';
import {
  X,
  FolderOpen,
  Terminal,
  Cpu,
  Save,
  Wrench,
  Loader2,
  CheckCircle2,
  Palette,
  Link2,
  SlidersHorizontal,
  Settings2,
  Gauge,
  RotateCw,
  Lock,
} from 'lucide-react';
import { AppSettings, tauriAPI } from '../types';
import {
  API_PROVIDERS,
  describeKeyFormat,
  extractTokenValue,
  getApiProvider,
  injectTokenValue,
  isValidKeyForProvider,
} from '../services/apiProviders';
import { APP_ICON_GROUPS, getAppIcon } from '../services/appIcon';

interface SettingsPageProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  /** Section to land on when the page opens (defaults to 'general'). */
  initialSection?: SectionId;
}

export type SectionId = 'general' | 'ai' | 'appearance' | 'editor' | 'linking' | 'system';

/** Preset swatches for the appearance accent-color picker. */
const ACCENT_PRESETS = [
  '#FEB05D', // amber (default)
  '#FB923C', // orange
  '#F87171', // red
  '#FB7185', // rose
  '#A78BFA', // violet
  '#818CF8', // indigo
  '#38BDF8', // sky
  '#2DD4BF', // teal
  '#34D399', // emerald
  '#A3E635', // lime
];

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: 'general', label: 'Vault & Ingestion', icon: <FolderOpen className="w-4 h-4" /> },
  { id: 'ai', label: 'AI Co-Pilot', icon: <Cpu className="w-4 h-4" /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
  { id: 'editor', label: 'Editor', icon: <Gauge className="w-4 h-4" /> },
  { id: 'linking', label: 'Linking & Search', icon: <Link2 className="w-4 h-4" /> },
  { id: 'system', label: 'System', icon: <Settings2 className="w-4 h-4" /> },
];

/* ------------------------------------------------------------------ */
/* Small building blocks (kept local — only used by this page)         */
/* ------------------------------------------------------------------ */

const SectionTitle: React.FC<{ children: React.ReactNode; hint?: string }> = ({ children, hint }) => (
  <div className="mb-5">
    <h3 className="text-sm font-semibold text-slate-100">{children}</h3>
    {hint && <p className="text-xs text-slate-500 mt-1 leading-relaxed">{hint}</p>}
  </div>
);

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children,
}) => (
  <div className="py-3.5 border-b border-slate-800/60 last:border-b-0">
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-300">{label}</div>
        {hint && <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  </div>
);

/**
 * Fully custom accent-color picker (no native `<input type="color">`, which
 * would open the OS/WebView2 picker). Renders a saturation/value field, a
 * hue slider and a hex input inside a popover.
 */
type ColorFormat = 'hex' | 'rgb' | 'hsl';

/**
 * Circular color wheel: hue around the ring, saturation toward the center
 * (white core). Drag to pick a hue + saturation; value/lightness is held by
 * the caller so it can adjust it separately (L slider in HSL mode).
 */
const ColorWheel: React.FC<{
  h: number;
  s: number;
  onChange: (h: number, s: number) => void;
  size?: number;
  /** 'hsv' renders the classic full-bright wheel; 'hsl' renders at the
   *  current lightness so the wheel gets duller/brighter with the L slider. */
  variant?: 'hsv' | 'hsl';
  /** Current lightness (0-100) used when variant === 'hsl'. */
  lightness?: number;
}> = ({ h, s, onChange, size = 176, variant = 'hsv', lightness = 50 }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const markerSize = 16;

  // Keep the whole marker inside the circle: its center can travel at most
  // to (radius - half the marker), in percentage of the wheel width.
  const maxRadiusPct = 50 - (markerSize / 2 / (size / 2)) * 50;

  // Wheel colors: at radius r the shown color is exactly hsl(h, r, L) — a
  // linear grey(L) → pure-hue(L) blend — matching what picking at r yields.
  const l = Math.min(100, Math.max(0, lightness));
  const wheelBackground =
    variant === 'hsl'
      ? `radial-gradient(closest-side, hsl(0 0% ${l}%), rgba(255,255,255,0) 100%), conic-gradient(from 0deg, hsl(0 100% ${l}%), hsl(60 100% ${l}%), hsl(120 100% ${l}%), hsl(180 100% ${l}%), hsl(240 100% ${l}%), hsl(300 100% ${l}%), hsl(360 100% ${l}%))`
      : 'radial-gradient(closest-side, #fff 0%, rgba(255,255,255,0) 100%), conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';

  const updateFromPointer = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    const radius = Math.min(1, Math.hypot(dx, dy) / (rect.width / 2));
    // atan2 gives 0° at 3 o'clock, clockwise positive (screen y is down);
    // +90° shifts so hue 0 (red) sits at 12 o'clock.
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    onChange(((deg % 360) + 360) % 360, radius);
  };

  // Marker position for the current hue/saturation, clamped inside the ring.
  const angleRad = ((h - 90) * Math.PI) / 180;
  const mx = 50 + Math.cos(angleRad) * s * maxRadiusPct;
  const my = 50 + Math.sin(angleRad) * s * maxRadiusPct;

  return (
    <div
      ref={ref}
      className="relative mx-auto cursor-crosshair touch-none rounded-full"
      style={{
        width: size,
        height: size,
        // Accurate wheel: red at 12 o'clock (hue 0 = top, matching the marker
        // mapping), and a LINEAR overlay so color at radius r = s exactly.
        background: wheelBackground,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)',
      }}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        updateFromPointer(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) updateFromPointer(e);
      }}
    >
      <div
        className="absolute w-4 h-4 rounded-full border-2 border-white pointer-events-none"
        style={{
          left: `${mx}%`,
          top: `${my}%`,
          transform: 'translate(-50%, -50%)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
        }}
      />
    </div>
  );
};

/** A single channel input (R/G/B or H/S/L) with clamping + caret-safe editing. */
const ChannelField: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, onChange }) => {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);

  // Sync from the actual color only when not editing, so the caret never jumps.
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] uppercase text-slate-500 font-semibold">{label}</span>
      <input
        value={text}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const n = Number(t);
          if (Number.isFinite(n) && n >= min && n <= max) onChange(clamp(n));
        }}
        onBlur={() => {
          setFocused(false);
          const n = Number(text);
          setText(String(Number.isFinite(n) ? clamp(n) : value));
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        inputMode="numeric"
        spellCheck={false}
        className="w-11 bg-slate-950 border border-slate-800 rounded px-1 py-1 text-center text-xs font-mono text-slate-200 focus:outline-none focus:border-brand-500 tabular-nums"
      />
    </div>
  );
};

/**
 * Fully custom accent-color picker (no native `<input type="color">`, which
 * would open the OS/WebView2 picker). Each format gets its own surface and
 * inputs: HEX gets the saturation/value field + hue slider, RGB and HSL get
 * a large circular color wheel plus per-channel inputs.
 */
const AccentPicker: React.FC<{ value: string; onChange: (hex: string) => void }> = ({
  value,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ColorFormat>('hex');
  const [hexText, setHexText] = useState(value);
  const [hexFocused, setHexFocused] = useState(false);
  const areaRef = useRef<HTMLDivElement | null>(null);

  const hsv = useMemo(() => hexToHsv(value), [value]);
  const rgb = useMemo(() => hexToRgb(value), [value]);
  const hsl = useMemo(() => hexToHsl(value), [value]);

  // Sync the hex text input with the actual color (preset clicks, drags) —
  // but never while it's focused, or the caret would jump around.
  useEffect(() => {
    if (open && !hexFocused) setHexText(value.toLowerCase());
  }, [open, hexFocused, mode, value]);

  const updateFromPointer = (e: React.PointerEvent) => {
    const el = areaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    onChange(hsvToHex(hsv.h, x, 1 - y));
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 border border-slate-800 bg-slate-950 hover:border-slate-600 rounded px-2 py-1.5 transition-colors cursor-pointer"
        title="Custom color"
      >
        <span
          className="w-5 h-5 rounded-full border border-black/40 shrink-0"
          style={{ backgroundColor: value }}
        />
        <span className="text-[11px] text-slate-400 font-mono">{value}</span>
      </button>

      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-full mb-2 z-50 w-72 p-3 bg-panel border border-slate-800 rounded-xl shadow-2xl space-y-3">
            {/* Format tabs */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase text-slate-500 font-semibold">Format</span>
              <div className="flex bg-slate-950 border border-slate-800 rounded p-0.5">
                {(['hex', 'rgb', 'hsl'] as ColorFormat[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setMode(f)}
                    className={`px-2 py-0.5 text-[10px] uppercase rounded transition-colors ${
                      mode === f
                        ? 'bg-brand-500/90 text-neutral-950 font-semibold'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* HEX: saturation/value field + hue slider */}
            {mode === 'hex' && (
              <>
                <div
                  ref={areaRef}
                  className="relative h-36 w-full cursor-crosshair touch-none"
                  style={{
                    background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`,
                  }}
                  onPointerDown={(e) => {
                    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                    updateFromPointer(e);
                  }}
                  onPointerMove={(e) => {
                    if (e.buttons === 1) updateFromPointer(e);
                  }}
                >
                  <div
                    className="absolute w-3.5 h-3.5 rounded-full border-2 border-white pointer-events-none"
                    style={{
                      left: `${hsv.s * 100}%`,
                      top: `${(1 - hsv.v) * 100}%`,
                      transform: 'translate(-50%, -50%)',
                      boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                    }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={1}
                  value={hsv.h}
                  onChange={(e) => onChange(hsvToHex(Number(e.target.value), hsv.s, hsv.v))}
                  className="hue-slider w-full cursor-pointer"
                  style={{
                    background:
                      'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
                  }}
                />
              </>
            )}

            {/* RGB: massive circular color pool */}
            {mode === 'rgb' && (
              <ColorWheel
                h={hsv.h}
                s={hsv.s}
                variant="hsv"
                onChange={(h, s) => onChange(hsvToHex(h, s, hsv.v))}
              />
            )}

            {/* HSL: massive circular color pool + lightness slider */}
            {mode === 'hsl' && (
              <>
                <ColorWheel
                  h={hsl.h}
                  s={hsl.s}
                  variant="hsl"
                  lightness={hsl.l}
                  onChange={(h, s) => onChange(hslToHex(h, s, hsl.l))}
                />
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase text-slate-500 font-semibold w-8">L</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(hsl.l)}
                    onChange={(e) => onChange(hslToHex(hsl.h, hsl.s, Number(e.target.value)))}
                    className="flex-1 accent-brand-500 cursor-pointer"
                    aria-label="Lightness"
                  />
                  <span className="text-[10px] text-slate-400 font-mono tabular-nums w-8 text-right">
                    {Math.round(hsl.l)}%
                  </span>
                </div>
              </>
            )}

            {/* Value row: swatch + mode-specific inputs */}
            <div className="flex items-center gap-2">
              <span
                className="w-7 h-7 rounded border border-slate-800 shrink-0"
                style={{ backgroundColor: value }}
              />
              {mode === 'hex' ? (
                <input
                  value={hexText}
                  onFocus={() => setHexFocused(true)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setHexText(v);
                    if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v);
                  }}
                  onBlur={() => {
                    setHexFocused(false);
                    setHexText(value.toLowerCase());
                  }}
                  spellCheck={false}
                  className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-brand-500"
                />
              ) : mode === 'rgb' ? (
                <div className="flex flex-1 gap-2 justify-center">
                  <ChannelField
                    label="R"
                    value={rgb.r}
                    min={0}
                    max={255}
                    onChange={(r) => onChange(rgbToHex(r, rgb.g, rgb.b))}
                  />
                  <ChannelField
                    label="G"
                    value={rgb.g}
                    min={0}
                    max={255}
                    onChange={(g) => onChange(rgbToHex(rgb.r, g, rgb.b))}
                  />
                  <ChannelField
                    label="B"
                    value={rgb.b}
                    min={0}
                    max={255}
                    onChange={(b) => onChange(rgbToHex(rgb.r, rgb.g, b))}
                  />
                </div>
              ) : (
                <div className="flex flex-1 gap-2 justify-center">
                  <ChannelField
                    label="H"
                    value={Math.round(hsl.h)}
                    min={0}
                    max={360}
                    onChange={(h) => onChange(hslToHex(h, hsl.s, hsl.l))}
                  />
                  <ChannelField
                    label="S"
                    value={Math.round(hsl.s)}
                    min={0}
                    max={100}
                    onChange={(s) => onChange(hslToHex(hsl.h, s, hsl.l))}
                  />
                  <ChannelField
                    label="L"
                    value={Math.round(hsl.l)}
                    min={0}
                    max={100}
                    onChange={(l) => onChange(hslToHex(hsl.h, hsl.s, l))}
                  />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/** Preset swatches + custom picker — used for every color setting. */
const AccentColorControl: React.FC<{ value: string; onChange: (hex: string) => void }> = ({
  value,
  onChange,
}) => (
  <div className="flex items-center gap-2 flex-wrap">
    {ACCENT_PRESETS.map((c) => {
      const isActive = value.toLowerCase() === c.toLowerCase();
      return (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`w-7 h-7 rounded-full border-2 transition-transform cursor-pointer ${
            isActive ? 'border-white scale-110' : 'border-transparent hover:scale-110'
          }`}
          style={{ backgroundColor: c }}
          title={c}
        />
      );
    })}
    <AccentPicker value={value} onChange={onChange} />
  </div>
);

const Toggle: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}> = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`w-10 h-5 p-0.5 border transition-colors shrink-0 ${
      checked ? 'bg-brand-500 border-brand-500' : 'bg-zinc-900 border-zinc-700'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
  >
    {/* Knob stays the same size AND color in both states so the toggle
        reads identically whether on or off — only its position moves. */}
    <span
      className={`block w-3.5 h-3.5 bg-neutral-100 transition-transform ${
        checked ? 'translate-x-[22px]' : 'translate-x-0'
      }`}
    />
  </button>
);

const NumberField: React.FC<{
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}> = ({ value, onChange, min, max, step = 1, suffix }) => (
  <div className="flex items-center gap-1.5">
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="w-24 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-brand-500 tabular-nums"
    />
    {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
  </div>
);

const RangeField: React.FC<{
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
}> = ({ label, value, onChange, min, max, step, format, disabled }) => {
  // Clicking the readout turns it into a text input (max two decimals);
  // Enter/blur commits clamped to [min, max], Esc cancels.
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const display = format ? format(value) : String(value);

  const startEdit = () => {
    setEditText(display);
    setEditing(true);
  };
  const commitEdit = () => {
    setEditing(false);
    const n = parseFloat(editText.replace(',', '.'));
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(max, Math.max(min, n));
    onChange(Number(clamped.toFixed(2)));
  };

  return (
    <div className={`flex items-center gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-40 accent-brand-500"
        aria-label={label}
        disabled={disabled}
      />
      {editing ? (
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onFocus={(e) => e.target.select()}
          className="w-14 bg-slate-950 border border-brand-500 rounded px-1.5 py-0.5 text-xs text-slate-200 focus:outline-none tabular-nums text-right"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          title="Click to type a value"
          className="w-14 text-right text-xs text-slate-400 hover:text-brand-400 tabular-nums cursor-text transition-colors"
        >
          {display}
        </button>
      )}
    </div>
  );
};

const Segmented: React.FC<{
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}> = ({ options, value, onChange }) => (
  <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5">
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        onClick={() => onChange(o.value)}
        className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
          value === o.value
            ? 'bg-brand-500/90 text-neutral-950 font-medium'
            : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const TextField: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  mono?: boolean;
  maxLength?: number;
  disabled?: boolean;
  className?: string;
}> = ({ value, onChange, placeholder, type = 'text', mono, maxLength, disabled, className }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    maxLength={maxLength}
    disabled={disabled}
    className={`bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-500 ${
      mono ? 'font-mono' : ''
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${className ?? 'w-full'}`}
  />
);

/* ------------------------------------------------------------------ */
/* Settings page                                                       */
/* ------------------------------------------------------------------ */

export const SettingsPage: React.FC<SettingsPageProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
  initialSection = 'general',
}) => {
  const [section, setSection] = useState<SectionId>('general');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [isInstallingEngine, setIsInstallingEngine] = useState(false);
  const [installLogs, setInstallLogs] = useState<string | null>(null);
  // Dirty tracking: any patch marks the draft unsaved; closing with unsaved
  // changes asks the user to discard or apply. Save keeps the panel open.
  const [isDirty, setIsDirty] = useState(false);
  const [showUnsaved, setShowUnsaved] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);
  const [showIconPreview, setShowIconPreview] = useState(false);

  // Re-seed the draft whenever the page is (re)opened with fresh settings.
  const [lastOpen, setLastOpen] = useState(isOpen);
  if (isOpen && !lastOpen) {
    setLastOpen(true);
    setDraft(settings);
    setInstallLogs(null);
    setSection(initialSection);
    setIsDirty(false);
    setShowUnsaved(false);
    setJustSaved(false);
  } else if (!isOpen && lastOpen) {
    setLastOpen(false);
  }

  // Closing (X, Cancel, Esc) with unsaved changes asks first. Defined before
  // the early return so the Esc effect below can reference it.
  const requestClose = () => {
    if (isDirty) setShowUnsaved(true);
    else onClose();
  };

  // Esc closes settings — but goes through the unsaved-changes guard.
  // Must live above the `if (!isOpen) return null` early return: hooks have
  // to run unconditionally or React throws "rendered more hooks than...".
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isDirty]);

  if (!isOpen) return null;

  // Active AI provider from the registry (drives key placeholder + format hint).
  const aiProvider = getApiProvider(draft.omniRoute.provider);

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setIsDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const patchNested = <K extends 'omniRoute' | 'appearance' | 'editor' | 'linking' | 'system'>(
    key: K,
    value: AppSettings[K]
  ) => {
    setIsDirty(true);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const handleSelectFolder = async () => {
    const selected = await tauriAPI.selectFolder();
    if (selected) patch('vaultPath', selected);
  };

  // Save changes but KEEP the settings panel open (shows a brief "Saved").
  const handleSave = () => {
    onSave(draft);
    setIsDirty(false);
    setJustSaved(true);
    if (savedTimer.current) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setJustSaved(false), 1600);
  };
  // Small "Apply & Close": saves and exits in one step.
  const handleApplyAndClose = () => {
    onSave(draft);
    setIsDirty(false);
    setShowUnsaved(false);
    onClose();
  };


  const runInstaller = async () => {
    setIsInstallingEngine(true);
    setInstallLogs(null);
    const res = await tauriAPI.runExtractorInstaller();
    setIsInstallingEngine(false);
    setInstallLogs(res.output);
  };

  // Restart the app. Persists the current draft first (Rust
  // ~/.prism/settings.json is the source of truth read on startup) so
  // unsaved changes survive, then closes and relaunches the whole process.
  const handleRefreshApp = async () => {
    try {
      await tauriAPI.saveRuntimeConfig(draft);
    } catch (e) {
      console.error('Failed to persist settings before refresh:', e);
    }
    try {
      await tauriAPI.relaunchApp();
    } catch (e) {
      console.error('Failed to relaunch app:', e);
      window.location.reload();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-neutral-950 text-neutral-100 select-none">
      {/* Left section nav */}
      <aside className="w-60 shrink-0 border-r border-slate-900 bg-slate-950/60 flex flex-col">
        <div className="flex items-center justify-between px-5 h-14 border-b border-slate-900 shrink-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-brand-400" />
            <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
          </div>
          <button
            onClick={requestClose}
            className="text-slate-400 hover:text-slate-200 hover:bg-slate-800 p-1.5 rounded-lg transition-colors"
            title="Close settings (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors text-left ${
                section === s.id
                  ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
              }`}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-slate-900 text-[10px] text-slate-600 leading-relaxed">
          Settings are persisted to <span className="font-mono">~/.prism/settings.json</span> by
          the Rust runtime.
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-8 py-8">
            {/* ------------------------- General ------------------------- */}
            {section === 'general' && (
              <div>
                <SectionTitle hint="Where your markdown notes live and how external content is imported.">
                  Vault & Ingestion
                </SectionTitle>

                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <div className="space-y-1.5 mb-4">
                    <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                      <FolderOpen className="w-4 h-4 text-brand-400" /> Note Vault Folder
                    </label>
                    <div className="text-xs text-slate-500">
                      The directory your ingest script outputs files to. All notes, folders and the
                      knowledge graph are indexed from here.
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={draft.vaultPath}
                      onChange={(e) => patch('vaultPath', e.target.value)}
                      placeholder="/path/to/your/notes"
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-500"
                    />
                    <button
                      onClick={handleSelectFolder}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-1.5 transition-colors border border-slate-700"
                    >
                      <FolderOpen className="w-4 h-4" /> Browse
                    </button>
                  </div>
                </div>

                <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-brand-400" /> Extractor Engine & Installer
                    </label>
                    <button
                      onClick={runInstaller}
                      disabled={isInstallingEngine}
                      className="text-xs bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors border border-brand-400/20"
                    >
                      {isInstallingEngine ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-200" />
                      ) : (
                        <Wrench className="w-3.5 h-3.5" />
                      )}
                      {isInstallingEngine ? 'Installing Dependencies...' : 'Run Auto-Installer'}
                    </button>
                  </div>
                  <div className="text-xs text-slate-500 mb-3">
                    Prism uses a built-in Python extractor. Click{' '}
                    <strong className="text-slate-300">Run Auto-Installer</strong> to set up FFmpeg,
                    Python 3.12, yt-dlp, faster-whisper and docling. <code>{'{vault_path}'}</code>{' '}
                    is replaced with the vault path at runtime.
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mb-1.5">
                    <Lock className="w-3 h-3 shrink-0" /> Read-only — the extractor & installer
                    engine is managed by Prism and can't be edited.
                  </div>
                  <textarea
                    value={draft.ingestionScript}
                    readOnly
                    rows={3}
                    spellCheck={false}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-400 cursor-not-allowed resize-y"
                  />
                  {installLogs && (
                    <div className="mt-3 p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-300 max-h-40 overflow-y-auto whitespace-pre-wrap select-text">
                      <div className="flex items-center gap-1.5 text-emerald-400 font-semibold mb-1">
                        <CheckCircle2 className="w-4 h-4" /> Installer Output Logs
                      </div>
                      {installLogs}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* --------------------------- AI ---------------------------- */}
            {section === 'ai' && (
              <div>
                <SectionTitle hint="Local + remote AI used by the Co-Pilot panel.">
                  AI Co-Pilot
                </SectionTitle>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Provider</label>
                    <select
                      value={draft.omniRoute.provider}
                      onChange={(e) => {
                        const id = e.target.value;
                        const next = getApiProvider(id);
                        // "None" just clears the provider; switching providers
                        // auto-fills the base URL and swaps the example model
                        // when it still holds the previous default.
                        if (!next) {
                          patchNested('omniRoute', { ...draft.omniRoute, provider: id });
                          return;
                        }
                        const current = getApiProvider(draft.omniRoute.provider);
                        patchNested('omniRoute', {
                          ...draft.omniRoute,
                          provider: next.id,
                          baseUrl: next.baseUrl,
                          model:
                            !draft.omniRoute.model || draft.omniRoute.model === current?.defaultModel
                              ? next.defaultModel
                              : draft.omniRoute.model,
                        });
                      }}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-brand-500 cursor-pointer"
                    >
                      <option value="">None — select a provider</option>
                      {API_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    {aiProvider ? (
                      <p className="text-[11px] text-slate-500 leading-relaxed">{aiProvider.note}</p>
                    ) : (
                      <p className="text-[11px] text-amber-500/90 leading-relaxed">
                        Choose a provider above to configure the AI Co-Pilot — the fields below
                        unlock once one is selected.
                      </p>
                    )}
                  </div>

                  {/* Extra provider-specific inputs (e.g. Cloudflare Account ID) */}
                  {aiProvider?.extraFields?.map((field) => (
                    <div className="space-y-1.5" key={field.token}>
                      <label className="text-xs font-medium text-slate-400">{field.label}</label>
                      <TextField
                        value={extractTokenValue(draft.omniRoute.baseUrl, field.token)}
                        onChange={(v) =>
                          patchNested('omniRoute', {
                            ...draft.omniRoute,
                            baseUrl: injectTokenValue(draft.omniRoute.baseUrl, field.token, v),
                          })
                        }
                        placeholder={field.placeholder}
                        mono
                        disabled={!aiProvider}
                      />
                      {field.hint && (
                        <p className="text-[11px] text-slate-500 leading-relaxed">{field.hint}</p>
                      )}
                    </div>
                  ))}

                  {aiProvider && aiProvider.needsKey ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-400">API Key</label>
                      <TextField
                        type="password"
                        value={draft.omniRoute.apiKey}
                        onChange={(v) => patchNested('omniRoute', { ...draft.omniRoute, apiKey: v })}
                        placeholder={aiProvider.keyPlaceholder}
                        mono
                        disabled={!aiProvider}
                      />
                      {draft.omniRoute.apiKey.trim() &&
                        !isValidKeyForProvider(aiProvider, draft.omniRoute.apiKey) && (
                          <p className="text-[11px] text-amber-500/90 leading-relaxed">
                            This doesn't look like a {aiProvider.name} API key — expected{' '}
                            {describeKeyFormat(aiProvider)}. Double-check it before saving.
                          </p>
                        )}
                    </div>
                  ) : aiProvider ? (
                    <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-400 leading-relaxed">
                      {aiProvider.name} runs locally — no API key required. Make sure the service
                      is running at <code className="font-mono text-slate-300">{aiProvider.baseUrl}</code>.
                    </div>
                  ) : null}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-400">API Base URL</label>
                      <TextField
                        value={draft.omniRoute.baseUrl}
                        onChange={(v) => patchNested('omniRoute', { ...draft.omniRoute, baseUrl: v })}
                        placeholder={aiProvider?.baseUrl ?? 'https://...'}
                        disabled={!aiProvider}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-400">Model</label>
                      <TextField
                        value={draft.omniRoute.model}
                        onChange={(v) => patchNested('omniRoute', { ...draft.omniRoute, model: v })}
                        placeholder="gpt-4o"
                        mono
                        disabled={!aiProvider}
                      />
                      <p className="text-[11px] text-amber-500/90 leading-relaxed">
                        Model name must be 100% accurate — it is sent to the provider exactly as
                        typed. Check your provider's docs for the exact model ID.
                      </p>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800/60">
                    <Field label="Creativity (temperature)">
                      <RangeField
                        label="temperature"
                        value={draft.omniRoute.temperature}
                        onChange={(v) =>
                          patchNested('omniRoute', { ...draft.omniRoute, temperature: v })
                        }
                        min={0}
                        max={2}
                        step={0.1}
                        format={(v) => v.toFixed(1)}
                        disabled={!aiProvider}
                      />
                    </Field>
                    <Field
                      label="Inject user profile into prompts"
                      hint="Prepend your profile below to every AI request so the model knows who it's helping."
                    >
                      <Toggle
                        checked={draft.omniRoute.injectUserProfile}
                        onChange={(v) =>
                          patchNested('omniRoute', { ...draft.omniRoute, injectUserProfile: v })
                        }
                        disabled={!aiProvider}
                      />
                    </Field>
                    <Field
                      label="User profile"
                      hint="Short context about yourself, e.g. I'm a PhD researcher in quantum computing. Injected only when the toggle above is on."
                    >
                      <textarea
                        value={draft.omniRoute.userProfile}
                        onChange={(e) =>
                          patchNested('omniRoute', { ...draft.omniRoute, userProfile: e.target.value })
                        }
                        rows={3}
                        disabled={!aiProvider}
                        placeholder="e.g. I'm a PhD researcher in quantum computing who likes concise, technical answers."
                        className="w-72 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-brand-500 resize-y disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                    </Field>
                  </div>
                </div>
              </div>
            )}

            {/* ------------------------ Appearance ----------------------- */}
            {section === 'appearance' && (
              <div>
                <SectionTitle hint="How Prism looks and what it opens to on launch.">
                  Appearance
                </SectionTitle>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <Field label="Startup view" hint="Which workspace layout to land on when the app opens.">
                    <Segmented
                      options={[
                        { value: 'graph', label: 'Graph' },
                        { value: 'editor', label: 'Editor' },
                        { value: 'split', label: 'Split' },
                        { value: 'topics', label: 'Topics' },
                      ]}
                      value={draft.appearance.startupView}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          startupView: v as AppSettings['appearance']['startupView'],
                        })
                      }
                    />
                  </Field>
                  <Field label="Default graph mode" hint="The 3D view is the default; 2D is lighter on CPU.">
                    <Segmented
                      options={[
                        { value: '2d', label: '2D' },
                        { value: '3d', label: '3D' },
                      ]}
                      value={draft.appearance.defaultGraphMode}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          defaultGraphMode: v as AppSettings['appearance']['defaultGraphMode'],
                        })
                      }
                    />
                  </Field>
                  <Field label="Graph background pattern" hint="The grid/mesh backdrop behind the knowledge graph.">
                    <Segmented
                      options={[
                        { value: 'grid', label: 'Grid' },
                        { value: 'mesh', label: 'Mesh' },
                        { value: 'solid', label: 'Solid' },
                      ]}
                      value={draft.appearance.backgroundPattern}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          backgroundPattern: v as AppSettings['appearance']['backgroundPattern'],
                        })
                      }
                    />
                  </Field>
                  <Field label="Label quality" hint="'High' renders crisp 3D labels at higher DPI (slightly more GPU).">
                    <Segmented
                      options={[
                        { value: 'standard', label: 'Standard' },
                        { value: 'high', label: 'High' },
                      ]}
                      value={draft.appearance.labelQuality}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          labelQuality: v as AppSettings['appearance']['labelQuality'],
                        })
                      }
                    />
                  </Field>
                  <Field label="Open AI Co-Pilot on start">
                    <Toggle
                      checked={draft.appearance.aiPanelOpenOnStart}
                      onChange={(v) =>
                        patchNested('appearance', { ...draft.appearance, aiPanelOpenOnStart: v })
                      }
                    />
                  </Field>
                  <Field label="Start with sidebar collapsed">
                    <Toggle
                      checked={draft.appearance.sidebarCollapsedOnStart}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          sidebarCollapsedOnStart: v,
                        })
                      }
                    />
                  </Field>
                  <Field label="Show LinkHub by default" hint="The link suggestion panel docked at the bottom of the editor.">
                    <Toggle
                      checked={draft.appearance.linkHubVisibleByDefault}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          linkHubVisibleByDefault: v,
                        })
                      }
                    />
                  </Field>
                  <Field label="LinkHub default height">
                    <NumberField
                      value={draft.appearance.linkHubDefaultHeight}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          linkHubDefaultHeight: v,
                        })
                      }
                      min={140}
                      max={520}
                      suffix="px"
                    />
                  </Field>
                  <Field label="Auto-rotate 3D graph on load" hint="Slowly orbits the camera around the graph when it opens.">
                    <Toggle
                      checked={draft.appearance.autoRotateOnLoad}
                      onChange={(v) =>
                        patchNested('appearance', { ...draft.appearance, autoRotateOnLoad: v })
                      }
                    />
                  </Field>
                  <Field label="Auto-rotate speed">
                    <RangeField
                      label="speed"
                      value={draft.appearance.autoRotateSpeed}
                      onChange={(v) =>
                        patchNested('appearance', { ...draft.appearance, autoRotateSpeed: v })
                      }
                      min={0.01}
                      max={3}
                      step={0.05}
                      format={(v) => `${v.toFixed(2)}×`}
                    />
                  </Field>
                  <Field label="Accent color" hint="Brand accent used across buttons, links, graph nodes and highlights. Applies instantly.">
                    <AccentColorControl
                      value={draft.appearance.accentColor}
                      onChange={(accentColor) =>
                        patchNested('appearance', { ...draft.appearance, accentColor })
                      }
                    />
                  </Field>
                  <Field
                    label="Hover glow color"
                    hint="The soft underglow behind buttons and sliders when you hover them."
                  >
                    <AccentColorControl
                      value={draft.appearance.hoverGlowColor}
                      onChange={(hoverGlowColor) =>
                        patchNested('appearance', { ...draft.appearance, hoverGlowColor })
                      }
                    />
                  </Field>
                  <Field
                    label="Graph node color"
                    hint="Base color for nodes in the 2D and 3D knowledge graphs (active note, existing notes and hover shades are derived from it)."
                  >
                    <AccentColorControl
                      value={draft.appearance.graphNodeColor}
                      onChange={(graphNodeColor) =>
                        patchNested('appearance', { ...draft.appearance, graphNodeColor })
                      }
                    />
                  </Field>
                  <Field
                    label="App icon"
                    hint="Pick a Prism logo — shown in the sidebar, title bar and splash screen."
                  >
                    <div className="space-y-4">
                      {APP_ICON_GROUPS.map((group) => (
                        <div key={group.id}>
                          <div className="text-[10px] uppercase font-semibold tracking-wider text-slate-500 mb-1.5">
                            {group.label}
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            {group.icons.map((opt) => {
                              const isActive = draft.appearance.appIcon === opt.id;
                              return (
                                <button
                                  key={opt.id}
                                  type="button"
                                  onClick={() =>
                                    patchNested('appearance', {
                                      ...draft.appearance,
                                      appIcon: opt.id,
                                    })
                                  }
                                  className={`p-2 rounded-lg border-2 transition-all cursor-pointer bg-slate-950 ${
                                    isActive
                                      ? 'border-brand-500'
                                      : 'border-slate-800 hover:border-slate-600'
                                  }`}
                                  title={opt.label}
                                >
                                  <img
                                    src={opt.url}
                                    alt={opt.label}
                                    className="w-10 h-10 object-contain mx-auto"
                                  />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowIconPreview(true)}
                          className="text-xs bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                        >
                          Preview
                        </button>
                        {draft.appearance.appIcon && (
                          <button
                            type="button"
                            onClick={() =>
                              patchNested('appearance', { ...draft.appearance, appIcon: '' })
                            }
                            className="text-xs text-slate-500 hover:text-rose-400 px-2 py-1.5 transition-colors cursor-pointer"
                          >
                            Reset to default
                          </button>
                        )}
                      </div>
                    </div>
                  </Field>
                  <Field
                    label="Sidebar status text"
                    hint="Shown beside the sidebar logo. Use {date} and {time} for live date/time, e.g. 'Keep building · {date}'."
                  >
                    <TextField
                      value={draft.appearance.sidebarStatusText}
                      onChange={(v) =>
                        patchNested('appearance', {
                          ...draft.appearance,
                          sidebarStatusText: v,
                        })
                      }
                      placeholder="e.g. Keep building · {date}"
                      maxLength={39}
                      className="w-[340px]"
                    />
                  </Field>
                </div>
              </div>
            )}

            {/* -------------------------- Editor ------------------------- */}
            {section === 'editor' && (
              <div>
                <SectionTitle hint="Typing, rendering and search tuning for the note editor.">
                  Editor
                </SectionTitle>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <Field label="Autosave debounce" hint="Pause after the last keystroke before a save is triggered.">
                    <NumberField
                      value={draft.editor.autosaveDebounceMs}
                      onChange={(v) => patchNested('editor', { ...draft.editor, autosaveDebounceMs: v })}
                      min={100}
                      max={10000}
                      step={100}
                      suffix="ms"
                    />
                  </Field>
                  <Field label="Full-render line threshold" hint="Notes above this many lines use windowed preview rendering.">
                    <NumberField
                      value={draft.editor.fullRenderLineThreshold}
                      onChange={(v) =>
                        patchNested('editor', { ...draft.editor, fullRenderLineThreshold: v })
                      }
                      min={500}
                      max={100000}
                      step={500}
                      suffix="lines"
                    />
                  </Field>
                  <Field label="Find-in-note debounce" hint="Delay between typing in the find box and rescanning the document.">
                    <NumberField
                      value={draft.editor.findDebounceMs}
                      onChange={(v) => patchNested('editor', { ...draft.editor, findDebounceMs: v })}
                      min={100}
                      max={5000}
                      step={100}
                      suffix="ms"
                    />
                  </Field>
                </div>
              </div>
            )}

            {/* ------------------------- Linking ------------------------- */}
            {section === 'linking' && (
              <div>
                <SectionTitle hint="Semantic linking, embeddings and how the knowledge graph is maintained.">
                  Linking & Search
                </SectionTitle>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <Field label="Auto-link on save" hint="Re-scan the note for link suggestions whenever it is saved.">
                    <Toggle
                      checked={draft.linking.autoLinkOnSave}
                      onChange={(v) => patchNested('linking', { ...draft.linking, autoLinkOnSave: v })}
                    />
                  </Field>
                  <Field
                    label="Similarity threshold"
                    hint="Minimum cosine similarity (0–1) for a semantic match to surface. Higher = stricter, fewer suggestions."
                  >
                    <RangeField
                      label="threshold"
                      value={draft.linking.similarityThreshold}
                      onChange={(v) =>
                        patchNested('linking', { ...draft.linking, similarityThreshold: v })
                      }
                      min={0}
                      max={1}
                      step={0.01}
                      format={(v) => v.toFixed(2)}
                    />
                  </Field>
                  <Field label="Embedding debounce" hint="Pause after a save before the note is re-embedded (debounced + coalesced).">
                    <NumberField
                      value={draft.linking.embedDebounceMs}
                      onChange={(v) => patchNested('linking', { ...draft.linking, embedDebounceMs: v })}
                      min={0}
                      max={60000}
                      step={500}
                      suffix="ms"
                    />
                  </Field>
                  <Field label="Backfill embeddings on vault open" hint="Embed every note without an embedding when a vault is first opened.">
                    <Toggle
                      checked={draft.linking.backfillOnVaultOpen}
                      onChange={(v) =>
                        patchNested('linking', { ...draft.linking, backfillOnVaultOpen: v })
                      }
                    />
                  </Field>
                  <Field
                    label="Embedding threads"
                    hint="ONNX intra-op thread cap (fastembed). Higher uses more CPU per inference; applied on next launch."
                  >
                    <NumberField
                      value={draft.linking.embeddingThreads}
                      onChange={(v) =>
                        patchNested('linking', { ...draft.linking, embeddingThreads: v })
                      }
                      min={1}
                      max={32}
                      suffix="threads"
                    />
                  </Field>
                  <Field label="Embedding batch size" hint="Notes embedded per inference pass during backfill.">
                    <NumberField
                      value={draft.linking.embeddingBatchSize}
                      onChange={(v) =>
                        patchNested('linking', { ...draft.linking, embeddingBatchSize: v })
                      }
                      min={1}
                      max={256}
                      suffix="notes"
                    />
                  </Field>
                  <Field label="Persist node positions" hint="Remember where you dragged nodes in the 2D graph between sessions.">
                    <Toggle
                      checked={draft.linking.persistNodePositions}
                      onChange={(v) =>
                        patchNested('linking', { ...draft.linking, persistNodePositions: v })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}

            {/* ------------------------- System -------------------------- */}
            {section === 'system' && (
              <div>
                <SectionTitle hint="Background services and data retention.">
                  System
                </SectionTitle>
                <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
                  <Field label="Watch the vault" hint="React to external file changes so the sidebar and graph stay in sync.">
                    <Toggle
                      checked={draft.system.watchVault}
                      onChange={(v) => patchNested('system', { ...draft.system, watchVault: v })}
                    />
                  </Field>
                  <Field label="Sync H1 headings on startup" hint="Rewrite each note's H1 to match its filename if they've drifted.">
                    <Toggle
                      checked={draft.system.syncH1OnStartup}
                      onChange={(v) => patchNested('system', { ...draft.system, syncH1OnStartup: v })}
                    />
                  </Field>
                  <Field
                    label="Version history retention"
                    hint="Delete version-history rows older than this many days (0 = keep everything)."
                  >
                    <NumberField
                      value={draft.system.versionRetentionDays}
                      onChange={(v) => patchNested('system', { ...draft.system, versionRetentionDays: v })}
                      min={0}
                      max={3650}
                      suffix="days"
                    />
                  </Field>
                  <Field
                    label="Refresh app"
                    hint="Restart the Prism window. Any unsaved changes are saved first, and settings that only apply on launch take effect."
                  >
                    <button
                      type="button"
                      onClick={handleRefreshApp}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-1.5 transition-colors border border-slate-700 cursor-pointer"
                    >
                      <RotateCw className="w-4 h-4" /> Refresh App
                    </button>
                  </Field>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-8 py-4 border-t border-slate-900 bg-slate-950/60 flex items-center justify-between">
          <div className="text-[11px] text-slate-600 flex items-center gap-1.5">
            <RotateCw className="w-3 h-3" />
            Some changes (embedding threads) apply on the next launch.
          </div>
          <div className="flex gap-2 items-center">
            <button
              onClick={requestClose}
              className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleApplyAndClose}
              className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors"
              title="Apply changes and close settings"
            >
              Apply & Close
            </button>
            <button
              onClick={handleSave}
              className={`px-4 py-2 bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-400 hover:to-brand-500 text-white text-sm font-medium rounded-lg flex items-center gap-1.5 shadow-md shadow-brand-500/10 hover:shadow-brand-500/20 transition-all border border-brand-400/20 ${
                justSaved ? 'from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500' : ''
              }`}
            >
              {justSaved ? (
                <>
                  <CheckCircle2 className="w-4 h-4" /> Saved
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" /> Save Changes
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* App icon preview popup — square, fills the settings panel height */}
      {showIconPreview && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowIconPreview(false)}
        >
          <div
            className="relative bg-panel border border-slate-800 shadow-2xl flex items-center justify-center p-6"
            style={{ height: 'min(94vh, 94vw)', width: 'min(94vh, 94vw)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowIconPreview(false)}
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-200 hover:bg-slate-800 p-1.5 rounded-lg transition-colors"
              title="Close preview"
            >
              <X className="w-4 h-4" />
            </button>
            <img
              src={getAppIcon(draft.appearance.appIcon)}
              alt="App icon preview"
              className="w-full h-full object-contain"
            />
          </div>
        </div>
      )}

      {/* Unsaved-changes guard: blurred backdrop + discard/apply choice */}
      {showUnsaved && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-80 bg-panel border border-slate-800 rounded-xl p-5 shadow-2xl">
            <h3 className="text-sm font-semibold text-slate-100 mb-1.5">Unsaved changes</h3>
            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              You have unsaved changes in Settings. What would you like to do?
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={handleApplyAndClose}
                className="w-full text-xs bg-brand-600 hover:bg-brand-500 text-white font-semibold px-3 py-2 rounded-lg transition-colors border border-brand-400/20 cursor-pointer"
              >
                Apply changes & close
              </button>
              <button
                onClick={onClose}
                className="w-full text-xs text-slate-300 hover:text-white hover:bg-slate-800 border border-slate-800 px-3 py-2 rounded-lg transition-colors cursor-pointer"
              >
                Discard changes
              </button>
              <button
                onClick={() => setShowUnsaved(false)}
                className="w-full text-xs text-slate-500 hover:text-slate-300 px-3 py-2 transition-colors cursor-pointer"
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
