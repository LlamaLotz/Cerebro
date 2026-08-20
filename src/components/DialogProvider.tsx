import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { X, AlertCircle, AlertTriangle, Type } from 'lucide-react';

// Prism's own dialog system — replaces the native window.alert / confirm /
// prompt everywhere. The provider keeps a FIFO queue of requests (so dialogs
// never clobber each other) and renders one themed modal at a time. The hook
// mirrors the native signatures: `alert` resolves when dismissed, `confirm`
// resolves with the user's choice, `prompt` resolves with the entered text or
// null when cancelled.

interface AlertOptions {
  title?: string;
}
interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red danger styling for destructive actions (delete, restore). */
  danger?: boolean;
}
interface PromptOptions {
  title?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface DialogContextValue {
  alert: (message: string, opts?: AlertOptions) => Promise<void>;
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>;
  prompt: (message: string, opts?: PromptOptions) => Promise<string | null>;
}

type DialogRequest =
  | {
      id: number;
      kind: 'alert';
      message: string;
      title?: string;
      resolve: () => void;
    }
  | {
      id: number;
      kind: 'confirm';
      message: string;
      title?: string;
      confirmLabel?: string;
      cancelLabel?: string;
      danger?: boolean;
      resolve: (value: boolean) => void;
    }
  | {
      id: number;
      kind: 'prompt';
      message: string;
      title?: string;
      initialValue?: string;
      placeholder?: string;
      confirmLabel?: string;
      resolve: (value: string | null) => void;
    };

const DialogContext = createContext<DialogContextValue | null>(null);

export const useDialog = (): DialogContextValue => {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog must be used inside <DialogProvider>');
  }
  return ctx;
};

let nextId = 1;

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [queue, setQueue] = useState<DialogRequest[]>([]);

  const current = queue[0] ?? null;

  const dismissCurrent = useCallback((resolve: (value?: any) => void, value?: any) => {
    setQueue((q) => {
      const [head, ...rest] = q;
      if (!head) return q;
      // Resolve AFTER the state update so the modal unmounts cleanly before
      // the caller's continuation runs.
      queueMicrotask(() => resolve(value));
      return rest;
    });
  }, []);

  const alert = useCallback(
    (message: string, opts?: AlertOptions): Promise<void> =>
      new Promise((resolve) => {
        setQueue((q) => [
          ...q,
          { id: nextId++, kind: 'alert', message, title: opts?.title, resolve },
        ]);
      }),
    []
  );

  const confirm = useCallback(
    (message: string, opts?: ConfirmOptions): Promise<boolean> =>
      new Promise((resolve) => {
        setQueue((q) => [
          ...q,
          {
            id: nextId++,
            kind: 'confirm',
            message,
            title: opts?.title,
            confirmLabel: opts?.confirmLabel,
            cancelLabel: opts?.cancelLabel,
            danger: opts?.danger,
            resolve,
          },
        ]);
      }),
    []
  );

  const prompt = useCallback(
    (message: string, opts?: PromptOptions): Promise<string | null> =>
      new Promise((resolve) => {
        setQueue((q) => [
          ...q,
          {
            id: nextId++,
            kind: 'prompt',
            message,
            title: opts?.title,
            initialValue: opts?.initialValue,
            placeholder: opts?.placeholder,
            confirmLabel: opts?.confirmLabel,
            resolve,
          },
        ]);
      }),
    []
  );

  const value: DialogContextValue = { alert, confirm, prompt };

  // Esc dismisses the active dialog (cancels confirms/prompts).
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (current.kind === 'alert') dismissCurrent(current.resolve);
      else dismissCurrent(current.resolve, current.kind === 'confirm' ? false : null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, dismissCurrent]);

  return (
    <DialogContext.Provider value={value}>
      {children}
      {current && <DialogModal key={current.id} request={current} dismiss={dismissCurrent} />}
    </DialogContext.Provider>
  );
};

const DialogModal: React.FC<{
  request: DialogRequest;
  dismiss: (resolve: (value?: any) => void, value?: any) => void;
}> = ({ request, dismiss }) => {
  const [promptValue, setPromptValue] = useState(request.kind === 'prompt' ? (request.initialValue ?? '') : '');
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the primary control when the modal mounts.
  useEffect(() => {
    const t = setTimeout(() => {
      if (request.kind === 'prompt') inputRef.current?.focus();
      else confirmBtnRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleConfirm = () => {
    if (request.kind === 'alert') dismiss(request.resolve);
    else if (request.kind === 'confirm') dismiss(request.resolve, true);
    else dismiss(request.resolve, promptValue);
  };

  const handleCancel = () => {
    if (request.kind === 'alert') dismiss(request.resolve);
    else dismiss(request.resolve, request.kind === 'confirm' ? false : null);
  };

  const isDanger = request.kind === 'confirm' && !!request.danger;
  const title =
    request.title ??
    (request.kind === 'alert' ? 'Notice' : request.kind === 'confirm' ? 'Please confirm' : 'Enter a value');
  const confirmLabel =
    (request.kind === 'confirm' || request.kind === 'prompt') && request.confirmLabel
      ? request.confirmLabel
      : 'OK';

  const Icon = request.kind === 'alert' ? AlertCircle : request.kind === 'confirm' ? AlertTriangle : Type;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        // Backdrop click = cancel (safe default for destructive actions).
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div
        className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden select-none"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`p-1.5 rounded-md shrink-0 ${
                isDanger
                  ? 'bg-red-500/10 border border-red-500/20 text-red-400'
                  : request.kind === 'alert'
                    ? 'bg-amber-500/10 border border-amber-500/20 text-amber-400'
                    : 'bg-brand-500/10 border border-brand-500/20 text-brand-400'
              }`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-semibold text-neutral-100 truncate">{title}</h3>
          </div>
          <button
            onClick={handleCancel}
            className="p-1 text-neutral-500 hover:text-red-400 hover:bg-neutral-800 rounded-md transition-colors shrink-0"
            title="Dismiss (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-[13px] leading-relaxed text-neutral-300 whitespace-pre-wrap break-words">
            {request.message}
          </p>
          {request.kind === 'prompt' && (
            <input
              ref={inputRef}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirm();
              }}
              placeholder={request.placeholder}
              className="mt-3 w-full px-3 py-2 text-sm bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-brand-500/60 focus:ring-1 focus:ring-brand-500/30 transition-colors select-text"
            />
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-neutral-800 flex items-center justify-end gap-2 bg-neutral-950/40">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            {request.kind === 'confirm' && request.cancelLabel ? request.cancelLabel : 'Cancel'}
          </button>
          <button
            ref={request.kind !== 'prompt' ? confirmBtnRef : undefined}
            onClick={handleConfirm}
            className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              isDanger
                ? 'bg-red-500/90 text-white hover:bg-red-400'
                : 'bg-brand-500/90 text-neutral-950 hover:bg-brand-400'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
