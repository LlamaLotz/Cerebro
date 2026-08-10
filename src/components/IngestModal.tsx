import React, { useState } from 'react';
import { X, File, Play, HelpCircle, AlertCircle } from 'lucide-react';
import { tauriAPI } from '../types';

interface IngestModalProps {
  isOpen: boolean;
  onClose: () => void;
  onIngest: (type: 'url' | 'file', value: string, method?: 'yt-dlp' | 'whisper' | 'A' | 'O' | 'N') => void;
}

export const IngestModal: React.FC<IngestModalProps> = ({
  isOpen,
  onClose,
  onIngest,
}) => {
  const [ingestType, setIngestType] = useState<'url' | 'file'>('url');
  const [urlValue, setUrlValue] = useState('');
  const [filePathValue, setFilePathValue] = useState('');
  const [ytMethod, setYtMethod] = useState<'yt-dlp' | 'whisper'>('yt-dlp');
  const [ocrMode, setOcrMode] = useState<'A' | 'O' | 'N'>('A');

  if (!isOpen) return null;

  const handleBrowseFile = async () => {
    const selected = await tauriAPI.selectFile();
    if (selected) {
      setFilePathValue(selected);
    }
  };

  const handleStartIngest = () => {
    if (ingestType === 'url') {
      const trimmed = urlValue.trim();
      if (!trimmed) {
        alert('Please enter a valid URL.');
        return;
      }
      onIngest('url', trimmed, ytMethod);
    } else {
      const trimmed = filePathValue.trim();
      if (!trimmed) {
        alert('Please select a file to ingest.');
        return;
      }
      onIngest('file', trimmed + '|' + ocrMode);
    }
    // Clean fields on successful launch
    setUrlValue('');
    setFilePathValue('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div 
        className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl flex flex-col animate-in fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <h2 className="text-base font-bold text-neutral-100 flex items-center gap-2">
            <Play className="w-4.5 h-4.5 text-orange-400 fill-current" /> Ingest New Content
          </h2>
          <button 
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 p-1.5 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
 
        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Tab Selection */}
          <div className="flex bg-neutral-950 border border-neutral-800/80 rounded-lg p-1 shrink-0">
            <button
              onClick={() => setIngestType('url')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-md transition-all ${
                ingestType === 'url'
                  ? 'bg-neutral-800 text-orange-400 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Play className="w-4 h-4 text-rose-500 fill-current" /> YouTube / Web Link
            </button>
            <button
              onClick={() => setIngestType('file')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-md transition-all ${
                ingestType === 'file'
                  ? 'bg-neutral-800 text-orange-400 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <File className="w-4 h-4 text-emerald-400" /> Local Document / Media
            </button>
          </div>
 
           {/* Conditional Input Rendering */}

           {ingestType === 'url' ? (
             <div className="space-y-3">
               <div className="flex items-center justify-between">
                 <label className="text-xs font-medium text-neutral-400">YouTube URL(s)</label>
                 <div className="flex bg-neutral-950 border border-neutral-800 rounded-lg p-1 gap-1">
                   <button
                     onClick={() => setYtMethod('yt-dlp')}
                     className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${
                       ytMethod === 'yt-dlp' ? 'bg-neutral-800 text-orange-400' : 'text-neutral-500 hover:text-neutral-300'
                     }`}
                   >
                     Captions
                   </button>
                   <button
                     onClick={() => setYtMethod('whisper')}
                     className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${
                       ytMethod === 'whisper' ? 'bg-neutral-800 text-orange-400' : 'text-neutral-500 hover:text-neutral-300'
                     }`}
                   >
                     Whisper
                   </button>
                 </div>
               </div>
               <div className="text-[10px] text-neutral-500 mb-1">
                 Enter a YouTube link. Multiple URLs can be entered, separated by commas.
               </div>
               <input
                 type="text"
                 value={urlValue}
                 onChange={(e) => setUrlValue(e.target.value)}
                 placeholder="https://www.youtube.com/watch?v=..."
                 className="w-full bg-neutral-950 border border-neutral-800 focus:border-orange-500 rounded-lg px-3 py-2 text-xs text-neutral-200 focus:outline-none"
               />
             </div>
           ) : (

            <div className="space-y-4">
              <label className="text-xs font-medium text-slate-400">Select File to Extract</label>
              <div className="text-[10px] text-slate-500 mb-1">
                Supported formats: PDFs, DOCX, XLSX, PPTX, MP3, WAV, MP4, MOV, PNG, JPG. Documents are layout-parsed via Docling; media is transcribed via Faster-Whisper.
              </div>
              
              <div className="flex gap-2">
                <input
                  type="text"
                  value={filePathValue}
                  onChange={(e) => setFilePathValue(e.target.value)}
                  placeholder="Click Browse to select file..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none"
                />
                <button
                  onClick={handleBrowseFile}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-2 rounded-lg transition-colors border border-slate-750 shrink-0"
                >
                  Browse File
                </button>
              </div>

              {/* OCR Mode Selection */}
              <div className="flex items-center justify-between mt-4">
                 <label className="text-xs font-medium text-neutral-400">OCR Parsing Mode</label>
                 <div className="flex bg-neutral-950 border border-neutral-800 rounded-lg p-1 gap-1">
                   {[
                     { label: 'Adaptive', value: 'A' },
                     { label: 'On', value: 'O' },
                     { label: 'Off', value: 'N' },
                   ].map((mode) => (
                     <button
                       key={mode.value}
                       onClick={() => setOcrMode(mode.value as 'A' | 'O' | 'N')}
                       className={`px-2 py-1 text-[10px] font-bold rounded transition-all ${
                         ocrMode === mode.value ? 'bg-neutral-800 text-orange-400' : 'text-neutral-500 hover:text-neutral-300'
                       }`}
                     >
                       {mode.label}
                     </button>
                   ))}
                 </div>
               </div>
            </div>
          )}

          {/* Info Badge */}
           <div className="p-3 bg-neutral-950/50 border border-neutral-850 rounded-xl flex gap-2.5">
             <AlertCircle className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
             <div className="text-[10px] text-neutral-400 leading-relaxed">
               <span className="font-semibold text-neutral-300 block mb-0.5">FOLDER SEGREGATION NOTICE:</span>
               Clean markdown notes will be output directly into your selected Cerebro notes vault. All intermediate metadata, raw transcribing tracks, and downloaded assets are safely kept in your isolated <code className="bg-neutral-900 text-orange-300 px-1 py-0.2 rounded font-mono">raw_service_files</code> directory.
             </div>
           </div>
         </div>
 
         {/* Footer */}
         <div className="px-6 py-4 border-t border-neutral-800 bg-neutral-950/30 flex justify-end gap-3 rounded-b-xl shrink-0">
           <button
             onClick={onClose}
             className="px-4 py-2 text-xs font-semibold text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
           >
             Cancel
           </button>
           <button
             onClick={handleStartIngest}
             className="px-4 py-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-400 hover:to-orange-500 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shadow-md shadow-orange-500/10 hover:shadow-orange-500/20 transition-all border border-orange-400/20"
           >
             <Play className="w-3.5 h-3.5 fill-current" /> Start Ingestion
           </button>
         </div>
       </div>
     </div>
  );
};
