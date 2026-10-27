import { expect, test, type Page, type BrowserContext } from '@playwright/test';

/**
 * Installs a fake LED hat behind both Web Bluetooth and the native BluetoothLe plugin bridge, so
 * plain web and app-shell pages can connect without hardware. It acks every write like the
 * in-app mock hat (`#mock`). Call it before `page.goto`.
 */
export async function installFakeHat(page: Page | BrowserContext) {
  const target = 'context' in page ? page.context() : page;
  await target.addInitScript(() => {
    const SERVICE = '0000a950-0000-1000-8000-00805f9b34fb';
    const CMD = '0000a951-0000-1000-8000-00805f9b34fb';
    const DATA = '0000a952-0000-1000-8000-00805f9b34fb';
    const NOTIFY = '0000a953-0000-1000-8000-00805f9b34fb';
    const NAME = 'iledcolor-FAKE';
    const sum = (b: number[]) => b.reduce((s, x) => (s + x) & 0xffff, 0);
    const finish = (b: number[]) => { const s = sum(b); return [...b, s >> 8, s & 0xff]; };
    const ack = (frame: Uint8Array) => frame[1] === 0x00
      ? finish([0x54, 0x00, 0, 5, frame[4]!, frame[5]!, frame[6]!, frame[7]!, 1])
      : finish([0x54, frame[1]!, 0, 3, 0x01]);

    // ---- Web Bluetooth ----
    class Characteristic extends EventTarget {
      value: DataView | null = null;
      constructor(public uuid: string, public properties: Record<string, boolean>, private notify?: () => Characteristic) { super(); }
      async startNotifications() { return this; }
      async stopNotifications() { return this; }
      async getDescriptors() { return []; }
      async writeValueWithoutResponse(d: BufferSource) {
        const bytes = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
        const target = this.notify!();
        setTimeout(() => {
          target.value = new DataView(Uint8Array.from(ack(bytes)).buffer);
          target.dispatchEvent(new Event('characteristicvaluechanged'));
        }, 0);
      }
    }
    const device = new EventTarget() as EventTarget & { id: string; name: string; gatt: unknown };
    const chars: Characteristic[] = [];
    const notifyChar = () => chars[2]!;
    chars.push(new Characteristic(CMD, { writeWithoutResponse: true }, notifyChar),
      new Characteristic(DATA, { writeWithoutResponse: true }, notifyChar),
      new Characteristic(NOTIFY, { notify: true }));
    const service = {
      uuid: SERVICE, isPrimary: true,
      getCharacteristic: async (u: string) => chars.find((c) => c.uuid === u),
      getCharacteristics: async () => chars,
    };
    const gatt = {
      connected: false, device,
      async connect() { gatt.connected = true; return gatt; },
      disconnect() { if (!gatt.connected) return; gatt.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
      getPrimaryService: async () => service,
      getPrimaryServices: async () => [service],
    };
    Object.assign(device, { id: 'fake-hat', name: NAME, gatt });
    const bluetooth = Object.assign(new EventTarget(), {
      getAvailability: async () => true,
      requestDevice: async () => device,
      getDevices: async () => [device],
    });
    Object.defineProperty(Navigator.prototype, 'bluetooth', { configurable: true, get: () => bluetooth });

    // ---- Native BluetoothLe plugin bridge (only used by the Android/iOS shells) ----
    const listeners = new Map<string, (data: unknown) => void>();
    let nextId = 0;
    const emit = (prefix: string, data: unknown) => {
      for (const [key, cb] of listeners) if (key.startsWith(prefix)) cb(data);
    };
    const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
    const unhex = (s: string) => Uint8Array.from(s.replace(/[^0-9a-f]/gi, '').match(/../g)!.map((x) => parseInt(x, 16)));
    const promiseMethods = ['initialize', 'isEnabled', 'requestDevice', 'connect', 'disconnect', 'getServices',
      'startNotifications', 'stopNotifications', 'writeWithoutResponse', 'readRssi', 'requestLEScan', 'stopLEScan', 'removeListener'];
    const cap = ((window as unknown as { Capacitor?: Record<string, unknown> }).Capacitor ??= {});
    Object.assign(cap, {
      PluginHeaders: [{
        name: 'BluetoothLe',
        methods: [...promiseMethods.map((name) => ({ name, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }],
      }],
      async nativePromise(_plugin: string, method: string, o: Record<string, unknown> = {}) {
        switch (method) {
          case 'isEnabled': return { value: true };
          case 'requestDevice': return { deviceId: 'fake-hat', name: NAME };
          case 'disconnect': setTimeout(() => emit(`disconnected|${String(o.deviceId)}`, {}), 0); return {};
          case 'getServices': return { services: [{ uuid: SERVICE, characteristics: [
            { uuid: CMD, properties: { writeWithoutResponse: true }, descriptors: [] },
            { uuid: DATA, properties: { writeWithoutResponse: true }, descriptors: [] },
            { uuid: NOTIFY, properties: { notify: true }, descriptors: [] },
          ] }] };
          case 'writeWithoutResponse': {
            const reply = hex(ack(unhex(String(o.value))));
            setTimeout(() => emit(`notification|${String(o.deviceId)}|`, { value: reply }), 0);
            return {};
          }
          case 'readRssi': return { value: -55 };
          case 'removeListener': listeners.delete(String(o.callbackId)); return {};
          default: return {};
        }
      },
      nativeCallback(_plugin: string, _method: string, o: { eventName: string }, cb: (data: unknown) => void) {
        const id = `${o.eventName}#${nextId++}`;
        listeners.set(id, cb);
        return id;
      },
    });
  });
}

export async function openBackup(page: Page) {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.locator('#btn-export')).toBeVisible();
}

/** Connects through the Custom tab and waits until the hat is ready. */
export async function connectHat(page: Page, selectedTab: 'custom' | 'presets' = 'custom') {
  const native = await page.evaluate(() => location.hash === '#mock' || Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()));
  if (await page.locator('#status').textContent().then((text) => text?.includes('Ready'))) {
    await page.getByRole('tab', { name: selectedTab === 'custom' ? 'Custom' : 'Presets', exact: true }).click();
    return;
  }
  if (native) {
    await page.getByRole('tab', { name: 'Custom', exact: true }).click();
    await page.click('#btn-connect');
  } else {
    await page.getByRole('tab', { name: 'Custom', exact: true }).click();
    const ownerReady = page.waitForEvent('popup');
    await page.click('#btn-connect');
    const owner = await ownerReady;
    await owner.getByRole('button', { name: 'Connect LED hat', exact: true }).click();
  }
  await expect(page.locator('#status')).toContainText('Ready', { timeout: 15000 });
  await page.getByRole('tab', { name: selectedTab === 'custom' ? 'Custom' : 'Presets', exact: true }).click();
}


/**
 * Waits until the service worker is active, i.e. it has precached the app (about 8 MB including OCR assets).
 * Parallel workers share one preview server, so this can take tens of seconds; the test gets a longer budget.
 */
export async function waitForServiceWorker(page: Page) {
  test.slow();
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
  });
}

export async function openCustomSection(page: Page, kind: 'text' | 'solid' | 'image' | 'github' | 'sequence') {
  const section = page.locator(`#custom-${kind}`);
  if (!(await section.evaluate((element: HTMLDetailsElement) => element.open))) {
    await section.locator('summary').click();
  }
}
