import React, { useState } from 'react';
import { X, FolderOpen, Terminal, Cpu, Save } from 'lucide-react';
import { AppSettings, tauriAPI } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
}) => {
  const [vaultPath, setVaultPath] = useState(settings.vaultPath);
  const [ingestionScript, setIngestionScript] = useState(settings.ingestionScript);
  const [apiKey, setApiKey] = useState(settings.omniRoute.apiKey);
  const [baseUrl, setBaseUrl] = useState(settings.omniRoute.baseUrl);
  const [model, setModel] = useState(settings.omniRoute.model);

  if (!isOpen) return null;

  const handleSelectFolder = async () => {
    const selected = await tauriAPI.selectFolder();
    if (selected) {
      setVaultPath(selected);
    }
  };

  const handleSave = () => {
    onSave({
      vaultPath,
      ingestionScript,
      omniRoute: {
        apiKey,
        baseUrl,
        model,
      },
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div 
        className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-xl shadow-2xl flex flex-col max-h-[90vh] animate-in fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <h2 className="text-xl font-semibold text-slate-100 flex items-center gap-2">
            <X className="w-5 h-5 text-sky-400 rotate-45" /> Settings
          </h2>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 hover:bg-slate-800 p-1.5 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          
          {/* Notes Directory (Vault) */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-sky-400" /> Note Vault Folder
            </label>
            <div className="text-xs text-slate-400 mb-1">
              Select the directory where your markdown notes reside. This is the folder your ingest script outputs files to.
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={vaultPath}
                onChange={(e) => setVaultPath(e.target.value)}
                placeholder="/path/to/your/notes"
                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500"
              />
              <button
                onClick={handleSelectFolder}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-1.5 transition-colors border border-slate-700"
              >
                <FolderOpen className="w-4 h-4" /> Browse
              </button>
            </div>
          </div>

          {/* Custom Ingestion Script */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-indigo-400" /> Ingestion Script Command
            </label>
            <div className="text-xs text-slate-400 mb-1">
              Command to trigger your ingest script. Use <code className="bg-slate-950 text-indigo-300 px-1 py-0.5 rounded font-mono">{"{vault_path}"}</code> as a placeholder for the actual note vault path.
            </div>
            <input
              type="text"
              value={ingestionScript}
              onChange={(e) => setIngestionScript(e.target.value)}
              placeholder="python /path/to/ingest.py --output {vault_path}"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>

          {/* OmniRoute AI Configurations */}
          <div className="border-t border-slate-800/60 pt-5 space-y-4">
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" /> OmniRoute AI Configuration
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5 col-span-2">
                <label className="text-xs font-medium text-slate-400">OmniRoute API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="omni-sk-..."
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">API Base URL</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.omniroute.ai/v1"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400">Model Name</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-b rounded-b-xl border-slate-800 bg-slate-950/40 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white text-sm font-medium rounded-lg flex items-center gap-1.5 shadow-md shadow-sky-500/10 hover:shadow-sky-500/20 transition-all border border-sky-400/20"
          >
            <Save className="w-4 h-4" /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
