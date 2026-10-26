export function initConnectionStatus(root: HTMLElement, onDisconnect: () => void) {
  const toggle = root.querySelector<HTMLButtonElement>('#status-toggle')!;
  const actions = root.querySelector<HTMLElement>('#connection-actions')!;
  const disconnect = root.querySelector<HTMLButtonElement>('#btn-status-disconnect')!;
  const linked = root.querySelector<SVGSVGElement>('#status-linked')!;
  const unlinked = root.querySelector<SVGSVGElement>('#status-unlinked')!;
  let connected = false;

  const close = () => {
    actions.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.onclick = () => {
    if (!connected) return;
    actions.hidden = !actions.hidden;
    toggle.setAttribute('aria-expanded', String(!actions.hidden));
  };
  disconnect.onclick = () => {
    if (!connected) return;
    close();
    onDisconnect();
    root.ownerDocument.getElementById('btn-connect')?.focus();
  };
  root.ownerDocument.addEventListener('click', (event) => {
    if (!event.composedPath().includes(root)) close();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !actions.hidden) {
      event.preventDefault();
      close();
      toggle.focus();
    }
  });

  return (isConnected: boolean) => {
    connected = isConnected;
    linked.toggleAttribute('hidden', !connected);
    unlinked.toggleAttribute('hidden', connected);
    toggle.disabled = !connected;
    if (!connected) close();
  };
}
