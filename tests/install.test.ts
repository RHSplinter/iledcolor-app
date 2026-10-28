// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { setupInstallPrompt } from '../src/ui/install';

afterEach(() => vi.unstubAllGlobals());
it('keeps installation available on the connection screen and passes the click to the browser', () => {
  document.body.innerHTML = '<button id="btn-install">Install app</button><p id="install-help" hidden></p>';
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  setupInstallPrompt();
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.defineProperty(event, 'prompt', { value: prompt });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  document.getElementById('btn-install')!.click();
  expect(prompt).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event('appinstalled'));
  expect(document.getElementById('btn-install')!.hidden).toBe(true);
});
it('hides Install app when already running in standalone display mode', () => {
  document.body.innerHTML = '<button id="btn-install">Install app</button>';
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  setupInstallPrompt();
  expect(document.getElementById('btn-install')!.hidden).toBe(true);
});
