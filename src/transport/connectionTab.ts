import type { Transport } from './types';

const LINK_KEY = 'iledcolor.connectionTab';
const links = new Map<string, ConnectionTabClient>();
export function savedConnectionTab(): string | null {
  try { return localStorage.getItem(LINK_KEY); } catch { return null; }
}
export function connectionTabClient(): ConnectionTabClient {
  let key = savedConnectionTab();
  if (!key) { key = crypto.randomUUID(); localStorage.setItem(LINK_KEY, key); }
  let client = links.get(key);
  if (!client) { client = new ConnectionTabClient(key); links.set(key, client); }
  return client;
}

interface Request { kind: 'request'; client: string; id: string; op: string; deviceId?: string; bytes?: number[] }
interface Message { kind: string; client: string; id?: string; error?: string; deviceId?: string; deviceName?: string; bytes?: number[] }
export interface TabConnection { transport: Transport; deviceId: string; deviceName: string }

export class ConnectionTabClient {
  private channel: BroadcastChannel;
  private client = crypto.randomUUID();
  private pending = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private notes = new Set<(bytes: Uint8Array) => void>();
  private drops = new Set<() => void>();
  constructor(key: string) {
    this.channel = new BroadcastChannel(`iledcolor.hat.${key}`);
    this.channel.onmessage = ({ data: m }: MessageEvent<Message>) => {
      if (m.client !== this.client) return;
      if (m.kind === 'reply' && m.id) {
        const pending = this.pending.get(m.id);
        if (m.error) pending?.reject(new Error(m.error)); else pending?.resolve(m);
      }
      if (m.kind === 'notification') this.notes.forEach((cb) => cb(Uint8Array.from(m.bytes ?? [])));
      if (m.kind === 'disconnected') this.drops.forEach((cb) => cb());
    };
  }
  close() {
    this.pending.forEach(({ reject }) => reject(new Error('LED Hat Connection client closed')));
    this.channel.close();
  }
  private request(op: string, fields: Partial<Request> = {}, timeout = 1500): Promise<Message> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('LED Hat Connection tab is not responding')); }, timeout);
      const finish = () => { clearTimeout(timer); this.pending.delete(id); };
      this.pending.set(id, { resolve: (m) => { finish(); resolve(m); }, reject: (e) => { finish(); reject(e); } });
      this.channel.postMessage({ ...fields, kind: 'request', client: this.client, id, op });
    });
  }
  async connect(deviceId?: string, timeout = 10000, isClosed?: () => boolean): Promise<TabConnection> {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (isClosed?.()) throw new Error('LED Hat Connection tab was closed');
      try {
        const result = await this.request('attach', { deviceId }, Math.min(600, Math.max(1, deadline - Date.now())));
        if (!result.deviceId || !result.deviceName) throw new Error('Choose your hat in the LED Hat Connection tab');
        return {
          deviceId: result.deviceId, deviceName: result.deviceName,
          transport: {
            writeCommand: async (bytes) => { await this.request('command', { bytes: [...bytes] }); },
            writeData: async (bytes) => { await this.request('data', { bytes: [...bytes] }); },
            onNotification: (cb) => { this.notes.add(cb); return () => this.notes.delete(cb); },
            onDisconnect: (cb) => { this.drops.add(cb); return () => this.drops.delete(cb); },
            disconnect: () => { void this.request('disconnect').catch(() => undefined); },
          },
        };
      } catch (error) {
        if (Date.now() + 250 >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}

/** The live Bluetooth objects stay in this tab's document when the control page refreshes. */
export function hostConnectionTab(key: string, onChange: (name: string | null) => void) {
  const channel = new BroadcastChannel(`iledcolor.hat.${key}`);
  let active: { transport: Transport; deviceId: string; deviceName: string } | null = null;
  let client = '';
  let unsub: Array<() => void> = [];
  const send = (m: object) => channel.postMessage({ ...m, client });
  const disconnect = () => {
    const old = active; active = null;
    unsub.forEach((cb) => cb()); unsub = [];
    old?.transport.disconnect();
    send({ kind: 'disconnected' }); onChange(null);
  };
  channel.onmessage = async ({ data: r }: MessageEvent<Request>) => {
    if (r.kind !== 'request') return;
    const reply = (fields: object = {}) => channel.postMessage({ kind: 'reply', client: r.client, id: r.id, ...fields });
    try {
      if (r.op === 'attach') {
        if (!active) throw new Error('Choose your hat in the LED Hat Connection tab');
        if (r.deviceId && r.deviceId !== active.deviceId) throw new Error('The connection tab is holding a different LED hat');
        if (client && client !== r.client) send({ kind: 'disconnected' });
        client = r.client;
        reply({ deviceId: active.deviceId, deviceName: active.deviceName }); return;
      }
      if (r.client !== client || !active) throw new Error('This page is not attached to the LED hat');
      if (r.op === 'command') await active.transport.writeCommand(Uint8Array.from(r.bytes ?? []));
      else if (r.op === 'data') await active.transport.writeData(Uint8Array.from(r.bytes ?? []));
      else if (r.op === 'disconnect') disconnect();
      else throw new Error('Unknown LED hat operation');
      reply();
    } catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }); }
  };
  return {
    setConnection(connection: TabConnection) {
      disconnect(); active = connection;
      unsub = [connection.transport.onNotification((bytes) => send({ kind: 'notification', bytes: [...bytes] })),
        connection.transport.onDisconnect(disconnect)];
      onChange(connection.deviceName);
    },
    disconnect,
    close() { disconnect(); channel.close(); },
  };
}
