import './style.css';
import { forgetWebHat } from '../transport/webBluetoothMemory';
import { connectWebBluetooth } from '../transport/webBluetooth';
import { hostConnectionTab, savedConnectionTab } from '../transport/connectionTab';

export function startConnectionTab() {
  document.title = 'LED Hat Connection';
  document.body.innerHTML = `<main style="max-width:600px;margin:2rem auto;padding:1rem">
    <h1>LED Hat Connection</h1>
    <p>This tab holds the Bluetooth connection to your LED hat so the main LED Hat Controller can refresh without pairing again.</p>
    <p><strong>Keep this tab open.</strong> Use the main app tab for text, images, and other controls. Closing or refreshing this tab ends the Bluetooth connection.</p>
    <p id="link-status" role="status">Choose your LED hat once to begin.</p>
    <button id="link-connect" class="primary">Choose LED hat</button>
    <button id="link-disconnect" hidden>Disconnect LED hat</button>
    <button id="link-return">Return to LED Hat Controller</button>
    <p id="link-error" role="alert"></p>
  </main>`;
  const status = document.getElementById('link-status')!;
  const choose = document.getElementById('link-connect') as HTMLButtonElement;
  const drop = document.getElementById('link-disconnect') as HTMLButtonElement;
  const error = document.getElementById('link-error')!;
  const key = savedConnectionTab();
  if (!key) { error.textContent = 'Open this tab using Connect in the main LED Hat Controller.'; choose.disabled = true; return; }
  const host = hostConnectionTab(key, (name) => {
    status.textContent = name ? `Connected to LED hat ${name}. You can return to the main app; leave this tab open.` : 'LED hat disconnected. Choose your hat to connect again.';
    choose.hidden = !!name; drop.hidden = !name;
  });
  window.addEventListener('pagehide', () => host.close(), { once: true });
  const returnToApp = () => { window.opener?.focus(); window.blur(); };
  choose.onclick = async () => {
    choose.disabled = true; error.textContent = '';
    try { host.setConnection(await connectWebBluetooth()); returnToApp(); }
    catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
    finally { choose.disabled = false; }
  };
  drop.onclick = () => { forgetWebHat(); host.disconnect(); };
  document.getElementById('link-return')!.onclick = returnToApp;
}
