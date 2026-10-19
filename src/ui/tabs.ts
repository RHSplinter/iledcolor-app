export function initTabs(tabBar: HTMLElement, onSelect: (name: string) => void) {
  const tabs = [...tabBar.querySelectorAll<HTMLButtonElement>('button[role="tab"]')];
  const available = () => tabs.filter((tab) => !tab.hidden && !tab.disabled);
  const panelFor = (tab: HTMLButtonElement) =>
    tabBar.ownerDocument.getElementById(tab.getAttribute('aria-controls') ?? '');

  const select = (name: string): boolean => {
    const next = available().find((tab) => tab.dataset.tab === name);
    if (!next || !panelFor(next)) return false;
    for (const tab of tabs) {
      const selected = tab === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = panelFor(tab);
      if (panel) panel.hidden = !selected;
    }
    onSelect(name);
    return true;
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => { if (tab.dataset.tab) select(tab.dataset.tab); });
  }
  tabBar.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const visible = available();
    const index = visible.findIndex((tab) => tab === tabBar.ownerDocument.activeElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % visible.length
      : event.key === 'ArrowLeft' ? (index + visible.length - 1) % visible.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : -1;
    if (next < 0) return;
    const tab = visible[next]!;
    if (tab.dataset.tab && select(tab.dataset.tab)) {
      event.preventDefault();
      tab.focus();
    }
  });
  return select;
}
