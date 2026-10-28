// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { SoundUi } from '../src/sound/ui';
import { GreetingUi } from '../src/scanner/ui';
import { connectAsPrimary, initApproach, keepBlackChanged, renderApproach } from '../src/approach/ui';
import { vibrateFeedback } from '../src/feedback';
import { verifyUtterance } from '../src/sound/analysis';
import { defaultPreferences } from '../src/sound/dictionary';
import type { DeviceController } from '../src/controller/deviceController';
import { solid } from '../src/render/matrix';
import { ensureFont } from '../src/render/text';
import { SPIKE_PROFILE } from '../src/transport/types';

vi.mock('../src/feedback', () => ({ vibrateFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/storage/db', () => ({
  loadKv: vi.fn().mockResolvedValue(undefined),
  saveKv: vi.fn().mockResolvedValue(undefined),
  savePreset: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/sound/capture', () => ({ SoundCapture: class { capabilities = async () => ({ speech: true, proximity: false }); } }));
vi.mock('../src/sound/analysis', async (original) => ({
  ...await original<typeof import('../src/sound/analysis')>(), verifyUtterance: vi.fn(),
}));
vi.mock('../src/scanner/extract', () => ({ extractNameSafely: vi.fn().mockResolvedValue({ firstname: 'Rob' }) }));
vi.mock('../src/render/matrix', async (original) => ({
  ...await original<typeof import('../src/render/matrix')>(),
  drawPreview: vi.fn(),
}));
vi.mock('../src/render/text', () => ({
  ensureFont: vi.fn().mockResolvedValue(undefined),
  getTextFont: () => 'silkscreen',
  renderMarquee: () => ({ frames: [solid(8, 8, [0, 0, 0])], unsupported: [] }),
  renderSpanMarquee: () => ({ frames: [solid(8, 8, [0, 0, 0])], unsupported: [], step: 2 }),
}));

const playback = vi.fn();
const target = {
  state: 'Ready', canRestoreContent: true, temporaryActive: false, playTemporary: playback,
} as unknown as DeviceController;
const context = {
  controller: () => target, logicalDims: (): [number, number] => [8, 8],
  physical: (image: ReturnType<typeof solid>) => image, marqueeDelay: () => 60,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(target, { state: 'Ready', canRestoreContent: true, temporaryActive: false });
  document.body.innerHTML = `
    <header>
      <div id="status-approach" class="pill muted" role="status" aria-live="polite">Approach: off</div>
      <div id="status-listening" class="pill muted" role="status" aria-live="polite">Listening: off</div>
    </header>
    <section id="view-approach"></section>
    <section id="view-sound"></section>
    <section id="view-scan"></section>`;
  playback.mockResolvedValue('completed');
  vi.mocked(verifyUtterance).mockReturnValue(true);
});

async function listening() {
  const ui = new SoundUi(context);
  await ui.init();
  ui['mode'] = 'listening';
  ui['profile'] = {} as NonNullable<typeof ui['profile']>;
  ui['preferences'].phrases = true;
  return ui;
}
const phrase = (text = 'Well, nice to meet you, everyone!') => ({ text, from: Date.now() - 1000, to: Date.now() });

it('vibrates once for a verified embedded phrase, suppressing duplicate detections during playback/cooldown', async () => {
  const ui = await listening();
  ui['phrase'](phrase());
  ui['phrase'](phrase());
  await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  ui['phrase'](phrase('hello'));
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it('does not vibrate for unmatched, disabled, unverified, pocket-paused or stale phrases', async () => {
  const ui = await listening();
  ui['phrase'](phrase('shelloworld'));
  ui['preferences'].reactions.greeting.enabled = false;
  ui['phrase'](phrase('hello'));
  ui['preferences'].reactions.greeting.enabled = true;
  vi.mocked(verifyUtterance).mockReturnValue(false);
  ui['phrase'](phrase('hello'));
  vi.mocked(verifyUtterance).mockReturnValue(true);
  ui['near'] = true;
  ui['phrase'](phrase('hello'));
  ui['near'] = false;
  ui['blockedUntil'] = Date.now() + 1;
  ui['phrase'](phrase('hello'));
  expect(vibrateFeedback).not.toHaveBeenCalled();
  expect(playback).not.toHaveBeenCalled();
});

it('does not vibrate for manual tests, room sounds or a busy cap', async () => {
  const ui = await listening();
  await ui['react']('greeting', true);
  ui['lastReaction'] = -Infinity;
  await ui['react']('applause');
  ui['lastReaction'] = -Infinity;
  ui['rendering'] = true;
  ui['phrase'](phrase('hello'));
  expect(vibrateFeedback).not.toHaveBeenCalled();
});

for (const manual of [false, true]) {
  it.each([
    ['upload starts', { state: 'Uploading' }],
    ['cap disconnects', { state: 'Disconnected' }],
    ['temporary playback starts', { temporaryActive: true }],
    ['restorable content disappears', { canRestoreContent: false }],
  ])(`rejects ${manual ? 'manual' : 'detected'} reactions when %s during frame rendering`, async (_reason, change) => {
    const ui = await listening();
    let finish!: () => void;
    vi.mocked(ensureFont).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const reaction = ui['react']('greeting', manual);
    expect(ensureFont).toHaveBeenCalledOnce();
    expect(playback).not.toHaveBeenCalled();
    expect(vibrateFeedback).not.toHaveBeenCalled();
    Object.assign(target, change);
    finish();
    await reaction;
    expect(playback).not.toHaveBeenCalled();
    expect(vibrateFeedback).not.toHaveBeenCalled();
    expect(ui['playing']).toBeUndefined();
    expect(ui['rendering']).toBe(false);
  });
}

it('plays and vibrates once after deferred frame rendering when the cap remains ready', async () => {
  const ui = await listening();
  let finish!: () => void;
  vi.mocked(ensureFont).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const reaction = ui['react']('greeting');
  expect(playback).not.toHaveBeenCalled();
  expect(vibrateFeedback).not.toHaveBeenCalled();
  finish();
  await reaction;
  expect(playback).toHaveBeenCalledOnce();
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it.each(['ocr', 'manual'] as const)('vibrates once when a recognized %s scan greeting starts playing, before completion', async (source) => {
  const ui = new GreetingUi(context);
  await ui.init();
  let finish!: (result: string) => void;
  playback.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const greeting = ui['greet']('Rob', target, source);
  await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  await ui['greet']('Rob', target, source);
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  finish('completed');
  await greeting;
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it.each([
  ['upload starts', { state: 'Uploading' }],
  ['cap disconnects', { state: 'Disconnected' }],
  ['temporary playback starts', { temporaryActive: true }],
])('does not vibrate for a scan greeting when %s before playback or on camera stop', async (_reason, change) => {
  const ui = new GreetingUi(context);
  await ui.init();
  Object.assign(target, change);
  await ui['greet']('Rob', target, 'ocr');
  ui.stopCamera();
  expect(playback).not.toHaveBeenCalled();
  expect(vibrateFeedback).not.toHaveBeenCalled();
});

it.each(['completed', 'cancelled'])('enables Scan and clears unknown content after a %s greeting', async (result) => {
  Object.assign(target, { canRestoreContent: false });
  playback.mockResolvedValueOnce(result);
  const ui = new GreetingUi(context);
  await ui.init();
  const scan = document.getElementById('qr-text-start') as HTMLButtonElement;
  expect(scan.textContent).toBe('Scan');
  expect(scan.classList.contains('primary')).toBe(true);
  expect(scan.disabled).toBe(false);
  expect(document.getElementById('qr-start')).toBeNull();
  await ui['greet']('Rob', target, 'ocr');
  expect(playback).toHaveBeenCalledWith(expect.any(Uint8Array), expect.any(Object), expect.any(Number), { clearIfUnknown: true });
  expect(vibrateFeedback).toHaveBeenCalledOnce();
  expect(document.getElementById('qr-status')!.textContent)
    .toBe(`${result === 'cancelled' ? 'Greeting ended early.' : 'Greeting finished.'} Display cleared to black.`);
  expect(scan.disabled).toBe(false);
});

it.each([
  { state: 'Disconnected' }, { state: 'Connecting' }, { state: 'Uploading' },
  { state: 'Error' }, { temporaryActive: true },
])('disables Scan when the cap is unavailable: %j', async (change) => {
  Object.assign(target, change);
  const ui = new GreetingUi(context);
  await ui.init();
  expect((document.getElementById('qr-text-start') as HTMLButtonElement).disabled).toBe(true);
});

it('updates the #status-listening header pill across idle, starting, enrolling, active, paused, and stopping states', async () => {
  const ui = new SoundUi(context);
  await ui.init();
  const pill = document.getElementById('status-listening')!;
  expect(pill.textContent).toBe('Listening: off');
  expect(pill.className).toBe('pill muted');
  ui['mode'] = 'starting';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: starting…');
  expect(pill.className).toBe('pill busy');
  ui['mode'] = 'enrolling';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: voice sample');
  expect(pill.className).toBe('pill busy');
  ui['mode'] = 'listening';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: on');
  expect(pill.className).toBe('pill ok');
  ui['preferences'].pauseInPocket = true;
  ui['setPocket'](true);
  expect(pill.textContent).toBe('Listening: paused');
  expect(pill.className).toBe('pill busy');
  ui['setPocket'](false);
  expect(pill.textContent).toBe('Listening: on');
  expect(pill.className).toBe('pill ok');
  ui['mode'] = 'stopping';
  ui.updateStatus();
  expect(pill.textContent).toBe('Listening: stopping…');
  expect(pill.className).toBe('pill busy');
});

it('updates #status-approach, vibrates when a group approach tier starts uploading, and keeps solo cap black when keepBlack is enabled', async () => {
  vi.useFakeTimers();
  try {
    let keepBlack = true;
    await initApproach({
      native: false, mock: true,
      profile: () => ({ ...SPIKE_PROFILE, interWriteDelayMs: 0 }),
      logicalDims: () => [8, 8],
      physical: (img) => img,
      renderContent: async () => ({ image: solid(8, 8, [255, 255, 255]) }),
      createContent: () => ({ kind: 'solid', color: '#ffffff' }),
      keepBlack: () => keepBlack,
      marqueeDelay: () => 60,
      trace: () => {},
      chooseCap: async () => ({ deviceId: 'mock-1', name: 'iledcolor-1' }),
      connectCap: async () => { throw new Error('unused'); },
      readRssi: async () => -55,
      startScan: async () => {},
      stopScan: async () => {},
      onPrimaryChange: () => {},
    });
    renderApproach();
    const pill = document.getElementById('status-approach')!;
    expect(pill.textContent).toBe('Approach: off');
    expect(pill.className).toBe('pill muted');
    await connectAsPrimary('mock-1', 'iledcolor-1');
    expect(vibrateFeedback).not.toHaveBeenCalled();
    expect(document.querySelector('#ap-caps .cap-note')?.textContent).toBe('keep black (idle)');
    (document.getElementById('ap-sim-peer') as HTMLButtonElement).click();
    const toggle = document.getElementById('ap-start') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(pill.className).toBe('pill ok');
    expect(pill.textContent).toMatch(/^Approach: on/);
    expect(vibrateFeedback).toHaveBeenCalledOnce();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(100);
    expect(pill.textContent).toBe('Approach: off');
    expect(pill.className).toBe('pill muted');
    keepBlack = false;
    await keepBlackChanged();
  } finally {
    vi.useRealTimers();
  }
});

it('refreshes imported emoji reaction text immediately without replacing device speech consent', async () => {
  const ui = await listening();
  ui['preferences'].allowBrowserSpeech = true;
  const imported = defaultPreferences();
  imported.reactions.greeting.text = 'WELCOME 👋';
  const prepared = ui.prepareImport(imported);
  ui.applyImported(prepared);
  expect((document.getElementById('sound-text-greeting') as HTMLInputElement).value).toBe('WELCOME 👋');
  expect(ui.exportPreferences().allowBrowserSpeech).toBe(true);
});
