// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initConnectionStatus } from '../src/ui/connectionStatus';
import shell from '../index.html?raw';

describe('connection status disclosure', () => {
  let root: HTMLElement;
  let toggle: HTMLButtonElement;
  let disconnect: HTMLButtonElement;
  let actions: HTMLElement;
  let update: ReturnType<typeof initConnectionStatus>;
  const onDisconnect = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = new DOMParser().parseFromString(shell, 'text/html').body.innerHTML;
    root = document.getElementById('connection-status')!;
    toggle = root.querySelector<HTMLButtonElement>('#status-toggle')!;
    disconnect = root.querySelector<HTMLButtonElement>('#btn-status-disconnect')!;
    actions = root.querySelector<HTMLElement>('#connection-actions')!;
    onDisconnect.mockReset();
    update = initConnectionStatus(root, onDisconnect);
  });

  it('cannot open or disconnect before a connection is ready', () => {
    expect(toggle.disabled).toBe(true);
    toggle.click();
    disconnect.click();
    expect(actions.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('toggles the disconnect button without replacing the status text or icons', () => {
    update(true);
    toggle.click();
    expect(actions.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(actions.id);
    expect(toggle.querySelector('#status-label')).not.toBeNull();
    expect(toggle.querySelector('#status-linked')).not.toBeNull();
    toggle.click();
    expect(actions.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the button open through connected status updates, such as upload progress', () => {
    update(true);
    toggle.click();
    update(true);
    expect(actions.hidden).toBe(false);
    expect(toggle.disabled).toBe(false);
  });

  it('switches SVG visibility attributes when connecting, uploading, disconnecting and reconnecting', () => {
    const linked = root.querySelector<SVGSVGElement>('#status-linked')!;
    const unlinked = root.querySelector<SVGSVGElement>('#status-unlinked')!;
    for (const connected of [false, true, true, false, true]) {
      update(connected);
      expect(linked.hasAttribute('hidden')).toBe(!connected);
      expect(unlinked.hasAttribute('hidden')).toBe(connected);
    }
  });

  it('disconnects only after selecting the revealed button and closes it', () => {
    update(true);
    toggle.click();
    expect(onDisconnect).not.toHaveBeenCalled();
    disconnect.click();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(actions.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('dismisses on outside click but not a click inside the disclosure', () => {
    update(true);
    toggle.click();
    actions.click();
    expect(actions.hidden).toBe(false);
    document.body.click();
    expect(actions.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('dismisses with Escape and restores focus to the pill', () => {
    update(true);
    toggle.click();
    disconnect.focus();
    disconnect.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(actions.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('closes on connection loss and stays closed after reconnecting', () => {
    update(true);
    toggle.click();
    update(false);
    expect(actions.hidden).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    disconnect.click();
    expect(onDisconnect).not.toHaveBeenCalled();
    update(true);
    expect(toggle.disabled).toBe(false);
    expect(actions.hidden).toBe(true);
  });
});
