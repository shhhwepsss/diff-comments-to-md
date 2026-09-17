import { useCallback, useState } from 'react';

// auto follows the OS; the explicit choice is remembered per browser.

export type ThemePref = 'auto' | 'light' | 'dark';

const KEY = 'local-review:theme';

function read(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function useThemePref(): [ThemePref, (next: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read);
  const update = useCallback((next: ThemePref) => {
    setPref(next);
    try {
      if (next === 'auto') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // storage blocked — the choice just won't survive a reload
    }
  }, []);
  return [pref, update];
}

/** Primer's ThemeProvider speaks day/night. */
export function primerColorMode(pref: ThemePref): 'auto' | 'day' | 'night' {
  return pref === 'light' ? 'day' : pref === 'dark' ? 'night' : 'auto';
}
