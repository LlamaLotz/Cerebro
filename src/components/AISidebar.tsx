import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, Send, Loader2, RefreshCw, FileText, 
  BookOpen, Link2, Hash, AlertTriangle 
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { NoteFile, OmniRouteConfig } from '../types';
import { summarizeNote, suggestConnections, suggestMetadata, sendChatMessage } from '../services/apiService';
import { buildChatSystemPrompt } from '../services/systemMessages';

interface AISidebarProps {
  note: NoteFile | null;
  allNotes: NoteFile[];
  config: OmniRouteConfig;
  onOpenSettings: () => void;
  onInsertText: (text: string) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const AISidebar: React.FC<AISidebarProps> = ({
  note,
  allNotes,
  config,
  onOpenSettings,
  onInsertText,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // Auto scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  const isConfigured = !!config.apiKey && !!config.baseUrl;

  const handleSend = async (text: string = inputValue) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;

    if (!isConfigured) {
      setError('AI is not configured. Please enter your OmniRoute API Key and Base URL in Settings.');
      return;
    }

    setError(null);
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    if (text === inputValue) setInputValue('');
    setIsLoading(true);

    try {
      // Build a full prompt context using the active note if it exists
      const fullMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
        {
          role: 'system',
          content: buildChatSystemPrompt(note),
        },
      ];

      // Add chat history
      messages.forEach((msg) => {
        fullMessages.push({ role: msg.role, content: msg.content });
      });

      // Add current message
      fullMessages.push({ role: 'user', content: trimmed });

      const response = await sendChatMessage(config, fullMessages);
      setMessages((prev) => [...prev, { role: 'assistant', content: response }]);
    } catch (err: any) {
      setError(err.message || 'An error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  const runQuickAction = async (action: 'summarize' | 'connect' | 'metadata') => {
    if (!note) return;
    if (!isConfigured) {
      setError('AI is not configured. Please enter your OmniRoute API Key and Base URL in Settings.');
      return;
    }

    setError(null);
    setIsLoading(true);

    const userMessageContent = 
      action === 'summarize' ? `Summarize this note: "${note.title}"` :
      action === 'connect' ? `Suggest wiki-link connections for note: "${note.title}"` :
      `Generate Frontmatter / tags metadata for note: "${note.title}"`;

    setMessages((prev) => [...prev, { role: 'user', content: userMessageContent }]);

    try {
      let response = '';
      if (action === 'summarize') {
        response = await summarizeNote(config, note.title, note.content ?? '');
      } else if (action === 'connect') {
        response = await suggestConnections(
          config,
          note.title,
          note.content ?? '',
          allNotes.map((n) => ({ title: n.title, content: n.content ?? '' }))
        );
      } else {
        response = await suggestMetadata(config, note.title, note.content ?? '');
      }

      setMessages((prev) => [...prev, { role: 'assistant', content: response }]);
    } catch (err: any) {
      setError(err.message || 'An error occurred.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-80 border-l border-slate-900 bg-panel flex flex-col h-full select-none">
      {/* Header */}
      <div className="p-4 border-b border-slate-900 flex items-center justify-between bg-panel">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4.5 h-4.5 text-brand-400 animate-pulse" />
          <h2 className="text-sm font-bold text-slate-100">OmniRoute AI Co-Pilot</h2>
        </div>
        <button
          onClick={() => setMessages([])}
          className="text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors"
          title="Clear Chat History"
        >
          Reset
        </button>
      </div>

      {/* Connection warning */}
      {!isConfigured && (
        <div className="m-3 p-3 bg-brand-950/20 border border-brand-900/50 rounded-xl flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-brand-400 shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <h4 className="text-[11px] font-semibold text-brand-200 leading-none">AI Integration Offline</h4>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              OmniRoute API keys or endpoints are missing. Paste your credentials to enable chat & note analysis.
            </p>
            <button
              onClick={onOpenSettings}
              className="text-[10px] font-bold text-brand-400 hover:text-brand-300 flex items-center gap-0.5"
            >
              Configure Now →
            </button>
          </div>
        </div>
      )}

      {/* Main chat viewport */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 select-text">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col justify-center text-center space-y-4 py-8 select-none">
            <div className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center mx-auto text-brand-400/80">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="space-y-1 max-w-xs mx-auto">
              <h3 className="text-xs font-semibold text-slate-300">Ask Prism Co-Pilot</h3>
              <p className="text-[10px] text-slate-500 leading-relaxed">
                Connect ideas, find links, generate summaries, or chat recursively with your note's context using OmniRoute routing.
              </p>
            </div>
            
            {/* Quick Actions drawer if a note is selected */}
            {note && isConfigured && (
              <div className="pt-4 max-w-xs mx-auto space-y-2">
                <span className="text-[9px] font-bold text-slate-500 tracking-wider uppercase block text-left">QUICK NOTE ACTIONS</span>
                
                <button
                  onClick={() => runQuickAction('summarize')}
                  className="w-full bg-slate-900/60 hover:bg-slate-900 border border-border text-[11px] text-slate-300 rounded-lg p-2 flex items-center gap-2 transition-all text-left"
                >
                  <BookOpen className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-200">Summarize Note</div>
                    <div className="text-[9px] text-slate-500">Create beautiful summary blocks</div>
                  </div>
                </button>

                <button
                  onClick={() => runQuickAction('connect')}
                  className="w-full bg-slate-900/60 hover:bg-slate-900 border border-border text-[11px] text-slate-300 rounded-lg p-2 flex items-center gap-2 transition-all text-left"
                >
                  <Link2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-200">Suggest Connections</div>
                    <div className="text-[9px] text-slate-500">Find files to link via [[WikiLinks]]</div>
                  </div>
                </button>

                <button
                  onClick={() => runQuickAction('metadata')}
                  className="w-full bg-slate-900/60 hover:bg-slate-900 border border-border text-[11px] text-slate-300 rounded-lg p-2 flex items-center gap-2 transition-all text-left"
                >
                  <Hash className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <div>
                    <div className="font-semibold text-slate-200">Generate Frontmatter</div>
                    <div className="text-[9px] text-slate-500">Paste tags & YAML headers at top</div>
                  </div>
                </button>
              </div>
            )}
          </div>
        ) : (
          messages.map((msg, index) => {
            const isUser = msg.role === 'user';
            return (
              <div 
                key={index} 
                className={`flex flex-col max-w-[85%] ${isUser ? 'ml-auto items-end' : 'mr-auto items-start'}`}
              >
                <span className="text-[9px] font-bold text-slate-500 mb-0.5">
                  {isUser ? 'YOU' : 'PRISM AI'}
                </span>
<div 
                   className={`text-xs p-3 rounded-2xl leading-relaxed ${
                     isUser 
                       ? 'bg-brand-500 text-slate-950 font-medium rounded-tr-none' 
                       : 'bg-surface border border-border text-slate-200 rounded-tl-none font-sans prose prose-invert prose-sm max-w-none'
                   }`}
                 >
                   {!isUser && <ReactMarkdown>{msg.content}</ReactMarkdown>}
                   {isUser && msg.content}
                 </div>
              </div>
            );
          })
        )}

        {/* Loading Indicator */}
        {isLoading && (
          <div className="flex flex-col items-start max-w-[85%] mr-auto">
            <span className="text-[9px] font-bold text-slate-500 mb-0.5">PRISM AI</span>
            <div className="bg-slate-900 border border-border p-3.5 rounded-2xl rounded-tl-none flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 text-brand-400 animate-spin" />
              <span className="text-xs text-slate-400">Consulting OmniRoute routing...</span>
            </div>
          </div>
        )}

        {/* Errors display */}
        {error && (
          <div className="p-3 bg-rose-950/20 border border-rose-900/50 rounded-xl flex items-start gap-2.5 text-rose-300 text-[11px]">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold leading-none block">Error</span>
              <span>{error}</span>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input section */}
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="p-3 border-t border-slate-900 bg-panel flex gap-2"
      >
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={note ? "Chat with active note context..." : "Ask Prism AI anything..."}
          className="flex-1 bg-slate-900/60 border border-border focus:border-slate-700 text-xs rounded-xl px-3.5 py-2 text-slate-200 focus:outline-none transition-colors"
        />
          <button
            type="submit"
            disabled={!inputValue.trim() || isLoading}
            className="bg-brand-600 hover:bg-brand-500 disabled:opacity-30 disabled:pointer-events-none text-white px-3.5 rounded-xl transition-all flex items-center justify-center border border-brand-500/20"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
      </form>
    </div>
  );
};
