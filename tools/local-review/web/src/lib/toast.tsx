import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '@primer/react';
import { AlertIcon, CheckCircleIcon, XIcon } from '@primer/octicons-react';
import { dismissToast, pushToast, toastDuration, type ToastItem } from './toastQueue';
import './toast.css';

// Primer has no toast. A short stack at the bottom: errors stay longer than
// info, a repeated message bumps its counter instead of stacking again.

type ToastFn = (message: string, error?: boolean) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function useToast(): ToastFn {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Mirrors `toasts` so show() computes the next list without a side-effecting updater.
  const list = useRef<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());
  const seq = useRef(0);

  const commit = useCallback((next: ToastItem[]) => {
    list.current = next;
    setToasts(next);
    // Evicted toasts must not fire a dismiss later.
    for (const [id, timer] of timers.current) {
      if (!next.some((t) => t.id === id)) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
    }
  }, []);

  const close = useCallback((id: number) => commit(dismissToast(list.current, id)), [commit]);

  const show = useCallback<ToastFn>(
    (message, error = false) => {
      const next = pushToast(list.current, { message, error }, seq.current + 1);
      if (next.id === seq.current + 1) seq.current += 1;
      window.clearTimeout(timers.current.get(next.id));
      timers.current.set(
        next.id,
        window.setTimeout(() => close(next.id), toastDuration(error)),
      );
      commit(next.list);
    },
    [close, commit],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="rv-toasts" aria-label="Уведомления">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rv-toast${toast.error ? ' rv-toast--error' : ''}`}
            role={toast.error ? 'alert' : 'status'}
          >
            <span className="rv-toast__icon">{toast.error ? <AlertIcon /> : <CheckCircleIcon />}</span>
            <span className="rv-toast__text">{toast.message}</span>
            {toast.count > 1 && <span className="rv-toast__count">×{toast.count}</span>}
            <IconButton icon={XIcon} aria-label="Закрыть" size="small" variant="invisible" onClick={() => close(toast.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
