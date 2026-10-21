// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { SoundUi } from '../src/sound/ui';
import { GreetingUi } from '../src/scanner/ui';
import { vibrateFeedback } from '../src/feedback';
import { verifyUtterance } from '../src/sound/analysis';
import { defaultPreferences } from '../src/sound/dictionary';
import type { DeviceController } from '../src/controller/deviceController';
import { solid } from '../src/render/matrix';

vi.mock('../src/feedback', () => ({ vibrateFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/storage/db', () => ({ loadKv: vi.fn(), saveKv: vi.fn() }));
vi.mock('../src/sound/capture', () => ({ SoundCapture: class { capabilities = async () => ({ speech: true, proximity: false }); } }));
vi.mock('../src/sound/analysis', async (original) => ({
  ...await original<typeof import('../src/sound/analysis')>(), verifyUtterance: vi.fn(),
}));
vi.mock('../src/scanner/extract', () => ({ extractNameSafely: vi.fn().mockResolvedValue({ firstname: 'Rob' }) }));
vi.mock('../src/render/text', () => ({
  ensureFont: vi.fn().mockResolvedValue(undefined),
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
  document.body.innerHTML = '<section id="view-sound"></section><section id="view-scan"></section>';
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

it.each(['camera', 'manual'] as const)('vibrates once after a successful %s scan greeting completes, not while it plays', async (source) => {
  const ui = new GreetingUi(context);
  await ui.init();
  let finish!: (result: string) => void;
  playback.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const greeting = ui['greet']('Rob', target, source);
  await vi.waitFor(() => expect(playback).toHaveBeenCalledOnce());
  await ui['greet']('Rob', target, source);
  expect(vibrateFeedback).not.toHaveBeenCalled();
  finish('completed');
  await greeting;
  expect(vibrateFeedback).toHaveBeenCalledOnce();
});

it.each(['cancelled', 'failed'])('does not vibrate for a %s scan greeting or camera stop', async (result) => {
  const ui = new GreetingUi(context);
  await ui.init();
  if (result === 'failed') playback.mockRejectedValueOnce(new Error('Disconnected'));
  else playback.mockResolvedValueOnce('cancelled');
  await ui['greet']('Rob', target, 'camera');
  ui.stopCamera();
  expect(vibrateFeedback).not.toHaveBeenCalled();
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
