import { describe, expect, it, beforeEach, vi } from 'vitest';

// settings.ts reads/writes localStorage directly (no injectable adapter),
// and this project's default test environment is plain node (no DOM) — so
// provide a minimal in-memory stand-in rather than pulling in jsdom for one
// file. Matches how settings.ts actually uses it: getItem/setItem only.
function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
  (globalThis as any).localStorage = ls;
  // settings.ts guards on `typeof window !== 'undefined'`, not localStorage
  // directly — this project's default test environment is plain node
  // (no DOM), so without this the store silently skips persistence.
  (globalThis as any).window = (globalThis as any).window ?? { localStorage: ls };
}

describe('projectSettings angle/grid snap fields', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    vi.resetModules();
  });

  it('defaults angle snap on at 45 degrees, matching the wall-drawing preview\u2019s prior hardcoded behaviour', async () => {
    const { projectSettings } = await import('$lib/stores/settings');
    let current: any;
    const unsub = projectSettings.subscribe((s) => { current = s; });
    unsub();
    expect(current.angleSnapEnabled).toBe(true);
    expect(current.angleSnapIncrement).toBe(45);
  });

  it('persists a changed angle increment across store reloads (localStorage round-trip)', async () => {
    const { projectSettings } = await import('$lib/stores/settings');
    projectSettings.update((s) => ({ ...s, angleSnapIncrement: 15, angleSnapEnabled: false }));
    const saved = JSON.parse((globalThis as any).localStorage.getItem('o3d_settings'));
    expect(saved.angleSnapIncrement).toBe(15);
    expect(saved.angleSnapEnabled).toBe(false);
  });

  it('grid size stays independently configurable from angle snap', async () => {
    const { projectSettings } = await import('$lib/stores/settings');
    projectSettings.update((s) => ({ ...s, gridSize: 10 }));
    let current: any;
    const unsub = projectSettings.subscribe((s) => { current = s; });
    unsub();
    expect(current.gridSize).toBe(10);
    expect(current.angleSnapIncrement).toBe(45); // unaffected by the grid change
  });
});
