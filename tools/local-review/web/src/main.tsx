import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles } from '@primer/react';
import { ThemeProvider } from '@primer/react/next';
import '@primer/primitives/dist/css/primitives.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import './styles/global.css';
import { App } from './App';
import { ToastProvider } from './lib/toast';
import { ConfirmProvider } from './lib/confirm';
import { primerColorMode, useThemePref } from './lib/theme';

function Root() {
  const [theme, setTheme] = useThemePref();
  return (
    <ThemeProvider colorMode={primerColorMode(theme)} dayScheme="light" nightScheme="dark">
      <BaseStyles className="rv-root">
        <ToastProvider>
          <ConfirmProvider>
            <App theme={theme} onTheme={setTheme} />
          </ConfirmProvider>
        </ToastProvider>
      </BaseStyles>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
