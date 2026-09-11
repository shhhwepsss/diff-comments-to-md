import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@primer/react';

// Promise-based confirmation: `if (await confirm({...})) doIt()`.

type ConfirmOptions = {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (result: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOptions(null);
    resolve?.(result);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options && (
        <Dialog
          title={options.title}
          role="alertdialog"
          width="large"
          onClose={() => close(false)}
          footerButtons={[
            { buttonType: 'default', content: 'Отмена', onClick: () => close(false), autoFocus: true },
            {
              buttonType: options.danger ? 'danger' : 'primary',
              content: options.confirmLabel,
              onClick: () => close(true),
            },
          ]}
        >
          {options.body}
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}
