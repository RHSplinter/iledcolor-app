import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { setupInstallPrompt } from './install';
import { forgetWebHat, saveWebHat } from '../transport/webBluetoothMemory';
import { bluetoothSupport, connectWebBluetooth } from '../transport/webBluetooth';
import { hostConnectionTab, ensureConnectionTabKey } from '../transport/connectionTab';

export function startConnectionTab() {
  document.title = 'LED Hat Connection';
  document.body.innerHTML = `<main style="max-width:600px;margin:2rem auto;padding:1rem">
    <h1>LED Hat Connection</h1>
    <p>Connect your LED hat here first. Once connected, the LED Hat Controller opens in another tab for text, images, and other controls.</p>
    <p><strong>Keep this tab open.</strong> It holds your LED hat's Bluetooth connection so you can refresh the controller without pairing again. Closing or refreshing this tab ends the Bluetooth connection.</p>
    <p id="link-status" role="status">Choose your LED hat to open the controller.</p>
    <button id="link-connect" class="primary">Connect LED hat</button>
    <button id="link-disconnect" hidden>Disconnect LED hat</button>
    <a id="link-return" class="action-link" target="iledcolor-led-hat-controller" rel="opener">Go to LED Hat Controller</a>
    <button id="btn-install">Install app</button>
    <p id="install-help" hidden>This installs a browser-based app on desktop or mobile. If no install prompt opens, use your browser menu to choose Install app. On a phone, this may be called Add to Home Screen.</p>
    <button id="link-update" hidden>Update app</button>
    <p id="link-error" role="alert"></p>
  </main>`;
  const status = document.getElementById('link-status')!;
  const choose = document.getElementById('link-connect') as HTMLButtonElement;
  const drop = document.getElementById('link-disconnect') as HTMLButtonElement;
  const back = document.getElementById('link-return') as HTMLAnchorElement;
  const error = document.getElementById('link-error')!;
  const controllerUrl = new URL(location.href);
  controllerUrl.search = '?controller=1'; controllerUrl.hash = 'scan';
  back.href = controllerUrl.href;
  let connected = false;
  setupInstallPrompt();
  const updateButton = document.getElementById('link-update') as HTMLButtonElement;
  const updateSW = registerSW({ onNeedRefresh() { updateButton.hidden = false; updateButton.disabled = connected; } });
  updateButton.onclick = () => { if (!connected) void updateSW(true); };
  let key: string;
  try { key = ensureConnectionTabKey(); }
  catch { error.textContent = 'Browser storage is unavailable. Enable storage for this site to connect your hat.'; choose.disabled = true; return; }
  const host = hostConnectionTab(key, (name) => {
    connected = !!name; updateButton.disabled = connected;
    status.textContent = name ? `Connected to LED hat ${name}. Use the controller tab; leave this connection tab open.` : 'LED hat disconnected. Connect here to reopen the controller.';
    controllerUrl.hash = name ? 'presets' : 'scan'; back.href = controllerUrl.href;
    choose.hidden = !!name; drop.hidden = !name; back.textContent = name ? 'Return to LED Hat Controller' : 'Go to LED Hat Controller';
  });
  window.addEventListener('pagehide', () => host.close(), { once: true });
  const openController = (reservedTab: Window | null) => {
    controllerUrl.hash = connected ? 'presets' : 'scan'; back.href = controllerUrl.href;
    const tab = reservedTab && !reservedTab.closed ? reservedTab : window.open(controllerUrl.href, 'iledcolor-led-hat-controller');
    if (tab) tab.location.href = controllerUrl.href;
    if (tab) tab.focus();
    else error.textContent = 'Your hat is connected. Use Return to LED Hat Controller to open the controller tab.';
  };
  choose.onclick = async () => {
    const support = bluetoothSupport();
    if (!support.ok) {
      status.textContent = 'No hat connected. You can still open the controller to scan badges.';
      error.textContent = support.reason;
      return;
    }
    choose.disabled = true; error.textContent = '';
    status.textContent = 'Searching for your LED hat... Select your hat in the browser picker and choose Pair.';
    let controllerTab: Window | null = null;
    try {
      // Start the picker first, then reserve the named tab while this click still
      // has user activation. Pairing can outlast the browser's popup allowance.
      const pairing = connectWebBluetooth();
      controllerTab = window.open('', 'iledcolor-led-hat-controller');
      const connection = await pairing;
      saveWebHat({ id: connection.deviceId, name: connection.deviceName });
      host.setConnection(connection);
      openController(controllerTab);
    } catch (e) {
      if (controllerTab && !controllerTab.closed && controllerTab.location.href === 'about:blank') controllerTab.close();
      status.textContent = 'No hat connected. Choose Connect LED hat to search again.';
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally { choose.disabled = false; }
  };
  drop.onclick = () => { forgetWebHat(); host.disconnect(); };
}
