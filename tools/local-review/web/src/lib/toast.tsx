import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '@primer/react';
import { AlertIcon, CheckCircleIcon, XIcon } from '@primer/octicons-react';
import './toast.css';

// Primer has no toast. This is the one the vanilla UI had: a single message
// at the bottom, errors stay longer than info.

type Toast = { id: number; message: string; error: boolean };
type ToastFn = (message: string, error?: boolean) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const seq = useRef(0);

  const show = useCallback<ToastFn>((message, error = false) => {
    window.clearTimeout(timer.current);
    seq.current += 1;
    setToast({ id: seq.current, message, error });
    timer.current = window.setTimeout(() => setToast(null), error ? 8000 : 5000);
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast && (
        <div key={toast.id} className={`rv-toast${toast.error ? ' rv-toast--error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          <span className="rv-toast__icon">{toast.error ? <AlertIcon /> : <CheckCircleIcon />}</span>
          <span className="rv-toast__text">{toast.message}</span>
          <IconButton icon={XIcon} aria-label="Закрыть" size="small" variant="invisible" onClick={() => setToast(null)} />
        </div>
      )}
    </ToastContext.Provider>
  );
}
