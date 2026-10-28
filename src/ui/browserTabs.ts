export const CONNECTION_TAB = 'iledcolor-led-hat-connection';
export const CONTROLLER_TAB = 'iledcolor-led-hat-controller';
const tabs = new Map<string, Window>();
const valid = (name: string) => name === CONNECTION_TAB || name === CONTROLLER_TAB;

function remember(tab: Window | null) {
  try { if (tab && !tab.closed && valid(tab.name)) tabs.set(tab.name, tab); } catch { /* Unrelated opener. */ }
}

remember(window.opener);
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || !event.source || event.data?.kind !== 'led-hat-tab-ready') return;
  const tab = event.source as Window;
  remember(tab);
  if (!event.data.reply) tab.postMessage({ kind: 'led-hat-tab-ready', reply: true }, location.origin);
});
try { window.opener?.postMessage({ kind: 'led-hat-tab-ready' }, location.origin); } catch { /* No accessible opener. */ }

/** Retain the actual window so returning does not depend on popup permission. */
export function openHatTab(url: string, name: string): Window | null {
  remember(window.opener);
  let tab = tabs.get(name);
  if (!tab || tab.closed) tab = window.open(url, name) ?? undefined;
  if (!tab) return null;
  tabs.set(name, tab);
  if (url && new URL(url, location.href).href !== tab.location.href) tab.location.href = url;
  tab.focus();
  return tab;
}
