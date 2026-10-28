/** Share the existing browser installation flow between connection and controller pages. */
export function setupInstallPrompt() {
  const button = document.getElementById('btn-install') as HTMLButtonElement | null;
  const help = document.getElementById('install-help');
  let deferred: (Event & { prompt(): Promise<void> }) | null = null;
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (button) {
    button.hidden = standalone;
    button.onclick = () => {
      if (deferred) void deferred.prompt();
      else if (help) help.hidden = false;
    };
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as typeof deferred;
    if (button && !standalone) button.hidden = false;
  });
  window.addEventListener('appinstalled', () => { if (button) button.hidden = true; });
}
