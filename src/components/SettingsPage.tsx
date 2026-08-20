import React, { useState } from 'react';
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
} from 'lucide-react';
import { AppSettings, tauriAPI } from '../types';

interface SettingsPageProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

type SectionId = 'general' | 'ai' | 'appearance' | 'editor' | 'linking' | 'system';

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: 'general', label: 'Vault & Ingestion', icon: <FolderOpen className="w-4 h-4" /> },
  { id: 'ai', label: 'AI Co-Pilot', icon: <Cpu className="w-4 h-4" /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
  { id: 'editor', label: 'Editor', icon: <Gauge className="w-4 h-4" /> },
  { id: 'linking', label: 'Linking & Search', icon: <Link2 className="w-4 h-4" /> },
  { id: 'system', label: 'System', icon: <Settings2 className="w-4 h-4" /> },
];

const COMMON_MODELS = [
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-3.5-turbo',
  'claude-3-5-sonnet',
  'claude-3-opus',
  'llama-3-70b',
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

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({
  checked,
  onChange,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={`relative w-10 h-[22px] rounded-full transition-colors shrink-0 ${
      checked ? 'bg-orange-500' : 'bg-slate-700'
    }`}
  >
    <span
      className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow transition-all ${
        checked ? 'left-[22px]' : 'left-[3px]'
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
      className="w-24 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-orange-500 tabular-nums"
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
}> = ({ label, value, onChange, min, max, step, format }) => (
  <div className="flex items-center gap-3">
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-40 accent-orange-500"
    />
    <span className="text-xs text-slate-400 tabular-nums w-14 text-right">
      {format ? format(value) : value}
    </span>
  </div>
);

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
            ? 'bg-orange-500/90 text-neutral-950 font-medium'
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
}> = ({ value, onChange, placeholder, type = 'text', mono }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    className={`w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-orange-500 ${
      mono ? 'font-mono' : ''
    }`}
  />
);

/* ------------------------------------------------------------------ */
/* Settings page                                                       */
/* ------------------------------------------------------------------ */

export const SettingsPage: React.FC<SettingsPageProps> = ({ isOpen, onClose, settings, onSave }) => {
  const [section, setSection] = useState<SectionId>('general');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [isInstallingEngine, setIsInstallingEngine] = useState(false);
  const [installLogs, setInstallLogs] = useState<string | null>(null);

  // Re-seed the draft whenever the page is (re)opened with fresh settings.
  const [lastOpen, setLastOpen] = useState(isOpen);
  if (isOpen && !lastOpen) {
    setLastOpen(true);
    setDraft(settings);
    setInstallLogs(null);
  } else if (!isOpen && lastOpen) {
    setLastOpen(false);
  }

  if (!isOpen) return null;

  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const patchNested = <K extends 'omniRoute' | 'appearance' | 'editor' | 'linking' | 'system'>(
    key: K,
    value: AppSettings[K]
  ) => setDraft((d) => ({ ...d, [key]: value }));

  const handleSelectFolder = async () => {
    const selected = await tauriAPI.selectFolder();
    if (selected) patch('vaultPath', selected);
  };

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  const runInstaller = async () => {
    setIsInstallingEngine(true);
    setInstallLogs(null);
    const res = await tauriAPI.runExtractorInstaller();
    setIsInstallingEngine(false);
    setInstallLogs(res.output);
  };

  return (
    <div className="fixed inset-0 z-50 flex bg-neutral-950 text-neutral-100 select-none">
      {/* Left section nav */}
      <aside className="w-60 shrink-0 border-r border-slate-900 bg-slate-950/60 flex flex-col">
        <div className="flex items-center justify-between px-5 h-14 border-b border-slate-900 shrink-0">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
          </div>
          <button
            onClick={onClose}
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
                  ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
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
                      <FolderOpen className="w-4 h-4 text-orange-400" /> Note Vault Folder
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
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-orange-500"
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
                      <Terminal className="w-4 h-4 text-orange-400" /> Extractor Engine & Installer
                    </label>
                    <button
                      onClick={runInstaller}
                      disabled={isInstallingEngine}
                      className="text-xs bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors border border-orange-400/20"
                    >
                      {isInstallingEngine ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-orange-200" />
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
                  <textarea
                    value={draft.ingestionScript}
                    onChange={(e) => patch('ingestionScript', e.target.value)}
                    rows={3}
                    spellCheck={false}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-orange-500 resize-y"
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
                    <label className="text-xs font-medium text-slate-400">OmniRoute API Key</label>
                    <TextField
                      type="password"
                      value={draft.omniRoute.apiKey}
                      onChange={(v) => patchNested('omniRoute', { ...draft.omniRoute, apiKey: v })}
                      placeholder="omni-sk-..."
                      mono
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-400">API Base URL</label>
                      <TextField
                        value={draft.omniRoute.baseUrl}
                        onChange={(v) => patchNested('omniRoute', { ...draft.omniRoute, baseUrl: v })}
                        placeholder="https://api.omniroute.ai/v1"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-400">Model</label>
                      <select
                        value={draft.omniRoute.model}
                        onChange={(e) =>
                          patchNested('omniRoute', { ...draft.omniRoute, model: e.target.value })
                        }
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-orange-500 cursor-pointer"
                      >
                        <option value="">Select a model...</option>
                        {COMMON_MODELS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                        <option value="custom">Custom Model...</option>
                      </select>
                    </div>
                  </div>
                  {draft.omniRoute.model === 'custom' ||
                  (!COMMON_MODELS.includes(draft.omniRoute.model) && draft.omniRoute.model) ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-400">Custom model name</label>
                      <TextField
                        value={draft.omniRoute.model}
                        onChange={(v) => patchNested('omniRoute', { ...draft.omniRoute, model: v })}
                        placeholder="my-custom-model"
                        mono
                      />
                    </div>
                  ) : null}

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
                      />
                    </Field>
                    <Field
                      label="User profile"
                      hint="Short context about yourself, e.g. \u201cI'm a PhD researcher in quantum computing\u201d. Injected only when the toggle above is on."
                    >
                      <textarea
                        value={draft.omniRoute.userProfile}
                        onChange={(e) =>
                          patchNested('omniRoute', { ...draft.omniRoute, userProfile: e.target.value })
                        }
                        rows={3}
                        placeholder="e.g. I'm a PhD researcher in quantum computing who likes concise, technical answers."
                        className="w-72 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-orange-500 resize-y"
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
                      min={0.1}
                      max={3}
                      step={0.05}
                      format={(v) => `${v.toFixed(2)}×`}
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
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 text-white text-sm font-medium rounded-lg flex items-center gap-1.5 shadow-md shadow-orange-500/10 hover:shadow-orange-500/20 transition-all border border-orange-400/20"
            >
              <Save className="w-4 h-4" /> Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
