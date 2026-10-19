// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTabs } from '../src/ui/tabs';
import shell from '../index.html?raw';

const names = ['connect', 'approach', 'scan', 'sound', 'settings'];
const button = (name: string) => document.getElementById(`tab-${name}`) as HTMLButtonElement;
const panel = (name: string) => document.getElementById(`view-${name}`)!;
const selected = vi.fn();
let select: ReturnType<typeof initTabs>;

function expectSelection(name: string) {
  for (const other of names) {
    expect(button(other).getAttribute('aria-selected')).toBe(String(other === name));
    expect(button(other).tabIndex).toBe(other === name ? 0 : -1);
    expect(panel(other).hidden).toBe(other !== name);
  }
}

function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  document.activeElement!.dispatchEvent(event);
  return event;
}

describe('tab navigation using the actual app shell', () => {
  beforeEach(() => {
    document.body.innerHTML = new DOMParser().parseFromString(shell, 'text/html').body.innerHTML;
    selected.mockReset();
    select = initTabs(document.getElementById('tab-bar')!, selected);
  });

  it('keeps Connect selected initially and Approach unavailable on web', () => {
    expectSelection('connect');
    expect(button('approach').hidden).toBe(true);
    expect(selected).not.toHaveBeenCalled();
  });

  it.each(['connect', 'scan', 'sound', 'settings'])('clicking %s selects only its associated panel', (name) => {
    button(name).querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expectSelection(name);
    expect(selected).toHaveBeenLastCalledWith(name);
  });

  it('programmatic preset navigation and native/mock Approach use the same selection', () => {
    button('approach').hidden = false;
    expect(select('approach')).toBe(true);
    expectSelection('approach');
    expect(select('connect')).toBe(true);
    expectSelection('connect');
    expect(selected.mock.calls).toEqual([['approach'], ['connect']]);
  });

  it('ignores unknown, hidden, disabled and missing-panel targets without clearing selection', () => {
    expect(select('missing')).toBe(false);
    expect(select('approach')).toBe(false);
    button('approach').click();
    button('sound').disabled = true;
    expect(select('sound')).toBe(false);
    button('scan').setAttribute('aria-controls', 'missing');
    expect(select('scan')).toBe(false);
    expectSelection('connect');
    expect(selected).not.toHaveBeenCalled();
  });

  it('wraps arrows, skips hidden tabs, and moves focus with selection', () => {
    button('connect').focus();
    for (const [key, name] of [
      ['ArrowRight', 'scan'], ['ArrowRight', 'sound'], ['ArrowRight', 'settings'],
      ['ArrowRight', 'connect'], ['ArrowLeft', 'settings'], ['ArrowLeft', 'sound'],
    ] as const) {
      expect(press(key).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(button(name));
      expectSelection(name);
    }
  });

  it('Home and End skip disabled tabs, while native/mock navigation includes Approach', () => {
    button('connect').focus();
    button('settings').disabled = true;
    press('End');
    expectSelection('sound');
    press('Home');
    expectSelection('connect');
    button('approach').hidden = false;
    press('ArrowRight');
    expectSelection('approach');
    expect(document.activeElement).toBe(button('approach'));
  });

  it('leaves ordinary and modified keys and focus outside the tab bar alone', () => {
    button('connect').focus();
    for (const key of ['Tab', 'ArrowUp', 'Escape']) expect(press(key).defaultPrevented).toBe(false);
    expect(press('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press('ArrowRight', { altKey: true }).defaultPrevented).toBe(false);
    expect(press('ArrowRight', { metaKey: true }).defaultPrevented).toBe(false);
    document.body.tabIndex = -1;
    document.body.focus();
    expect(press('End').defaultPrevented).toBe(false);
    expectSelection('connect');
    expect(selected).not.toHaveBeenCalled();
  });
});
