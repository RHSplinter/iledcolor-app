import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => {
    class Speech {
      lang = ''; continuous = true; interimResults = false;
      onresult = null; onerror = null; onend = null;
      start() {}
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: Speech, microphoneRequests: 0 });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const scope = window as Window & { microphoneRequests: number };
      scope.microphoneRequests++;
      throw new Error('Microphone permission denied for test.');
    } });
  });
  await page.goto('/#mock');
  await page.click('#btn-connect');
  await page.selectOption('#c-kind', 'solid');
  await page.click('#btn-send');
  await expect(page.locator('#send-note')).toContainText('Upload confirmed');
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
}

test('sound tab is opt-in, shows bilingual dictionary, and requires a wearer sample', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await setup(page);
  expect(await page.evaluate(() => (window as Window & { microphoneRequests: number }).microphoneRequests)).toBe(0);
  await expect(page.locator('#sound-profile')).toContainText('No voice sample');
  await expect(page.locator('#sound-pause-pocket')).toBeChecked();
  await expect(page.locator('#sound-pause-pocket')).toBeDisabled();
  await expect(page.locator('#sound-support')).toContainText('No proximity sensor');
  await page.check('#sound-phrases');
  await expect(page.locator('#sound-start')).toBeEnabled();
  await page.click('#sound-start');
  await expect(page.locator('#sound-error')).toContainText('Record a voice sample');
  expect(await page.evaluate(() => (window as Window & { microphoneRequests: number }).microphoneRequests)).toBe(0);
  await page.locator('#sound-reactions summary').first().click();
  await expect(page.locator('#sound-reactions details').first()).toContainText('good morning');
  await expect(page.locator('#sound-reactions details').first()).toContainText('guten morgen');
  await page.selectOption('#sound-language', 'de-DE');
  await expect(page.locator('#sound-language')).toBeEnabled();
  await page.fill('#sound-text-greeting', 'MOIN!');
  await page.locator('#sound-text-greeting').dispatchEvent('change');
  await expect(page.locator('#sound-start')).toBeEnabled();
  await page.click('#sound-preview-button');
  await expect(page.locator('#sound-error')).toBeEmpty();
  expect(await page.locator('#sound-preview').evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  await expect(page.locator('#sound-language')).toHaveValue('de-DE');
  await page.locator('#sound-reactions summary').first().click();
  await expect(page.locator('#sound-text-greeting')).toHaveValue('MOIN!');
  expect(errors).toEqual([]);
});

test('denied microphone permission stops capture and gives an actionable error', async ({ page }) => {
  await setup(page);
  await page.click('#sound-start');
  await expect(page.locator('#sound-error')).toContainText('Microphone permission denied');
  await expect(page.locator('#sound-status')).toContainText('Microphone is off');
  await expect(page.locator('#sound-start')).toBeEnabled();
  await page.click('#sound-enroll');
  await expect(page.locator('#sound-error')).toContainText('Microphone permission denied');
  await expect(page.locator('#sound-profile')).toContainText('No voice sample');
});

test('test reaction uses temporary cap playback and restores content without microphone access', async ({ page }) => {
  await setup(page);
  await page.click('#sound-test');
  await expect(page.locator('#sound-status')).toContainText('Playing Greeting');
  await expect(page.locator('#sound-end')).toBeVisible();
  await page.click('#sound-end');
  await expect(page.locator('#sound-status')).toContainText('Previous content restored', { timeout: 15000 });
  await expect(page.locator('#sound-error')).toBeEmpty();
  expect(await page.evaluate(() => (window as Window & { microphoneRequests: number }).microphoneRequests)).toBe(0);
});

test('voice enrollment, utterance filtering and microphone shutdown work end to end with simulated audio', async ({ page }) => {
  await setup(page);
  await page.clock.install();
  await page.evaluate(() => {
    let pitch = 180;
    window.addEventListener('test-pitch', (event) => { pitch = (event as CustomEvent<number>).detail; });
    class Context {
      state = 'running'; destination = {}; onstatechange: (() => void) | null = null;
      audioWorklet = { addModule: async () => {} };
      async resume() {}
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect: (node: unknown) => node }; }
      createGain() { return { gain: { value: 1 }, connect: () => {} }; }
    }
    class Worklet {
      port: { onmessage: ((event: { data: { samples: number[]; sampleRate: number } }) => void) | null } = { onmessage: null };
      interval = setInterval(() => this.port.onmessage?.({ data: { sampleRate: 16000,
        samples: Array.from({ length: 1024 }, (_, i) => 0.12 * (Math.sin(i * Math.PI * 2 * pitch / 16000)
          + 0.4 * Math.sin(i * Math.PI * 4 * pitch / 16000) + 0.2 * Math.sin(i * Math.PI * 6 * pitch / 16000))) } }), 64);
      connect(node: unknown) { return node; }
      disconnect() { clearInterval(this.interval); }
    }
    class Speech {
      lang = ''; continuous = true; interimResults = false;
      onresult: ((event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
      onerror = null; onend = null;
      emit = () => this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello' } }] });
      start() { window.addEventListener('test-phrase', this.emit); }
      abort() { window.removeEventListener('test-phrase', this.emit); }
    }
    Object.assign(window, { AudioContext: Context, AudioWorkletNode: Worklet, SpeechRecognition: Speech });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({
      getTracks: () => [{ stop: () => window.dispatchEvent(new Event('test-track-stopped')) }],
      getAudioTracks: () => [],
    }) });
  });
  await page.click('#sound-enroll');
  await expect(page.locator('#sound-status')).toContainText('Recording voice sample');
  await page.clock.runFor(12200);
  await expect(page.locator('#sound-profile')).toContainText('Voice sample saved');
  await page.check('#sound-phrases');
  await expect(page.locator('#sound-start')).toBeEnabled();
  await page.click('#sound-start');
  await expect(page.locator('#sound-error')).toContainText('Enable that permission explicitly');
  await page.check('#sound-cloud');
  await expect(page.locator('#sound-start')).toBeEnabled();
  await page.click('#sound-start');
  await expect(page.locator('#sound-status')).toContainText('Listening.');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-pitch', { detail: 300 })));
  await page.clock.runFor(1200);
  await page.evaluate(() => window.dispatchEvent(new Event('test-phrase')));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-pitch', { detail: 180 })));
  await page.clock.runFor(300);
  await expect(page.locator('#sound-status')).toContainText('Phrase ignored');
  await page.clock.runFor(1200);
  await page.evaluate(() => window.dispatchEvent(new Event('test-phrase')));
  await page.clock.runFor(300);
  await expect(page.locator('#sound-status')).toContainText('Playing Greeting');
  await page.clock.runFor(10000);
  await expect(page.locator('#sound-status')).toContainText('Previous content restored');
  await page.getByRole('tab', { name: 'Connect', exact: true }).click();
  await page.getByRole('tab', { name: 'Sound', exact: true }).click();
  await expect(page.locator('#sound-status')).toContainText('Microphone is off');
  await expect(page.locator('#sound-level')).toHaveAttribute('value', '0');
  await page.click('#sound-forget');
  await expect(page.locator('#sound-profile')).toContainText('No voice sample');
});

test('native proximity pauses recognition, drops pocket audio and resumes only when uncovered', async ({ page }) => {
  await page.route('https://api.github.com/**', (route) => route.fulfill({ json: [] }));
  await page.addInitScript(() => {
    const listeners = new Map<string, { name: string; cb: (value: unknown) => void }>();
    let nextId = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const emit = (name: string, value: unknown) => {
      for (const listener of listeners.values()) if (listener.name === name) listener.cb(value);
    };
    window.addEventListener('test-near', (event) => emit('proximity', { near: (event as CustomEvent<boolean>).detail }));
    Object.assign(window, {
      androidBridge: {},
      Capacitor: {
        PluginHeaders: [{ name: 'SoundDetection', methods: [
          { name: 'capabilities', rtype: 'promise' }, { name: 'start', rtype: 'promise' },
          { name: 'stop', rtype: 'promise' }, { name: 'addListener', rtype: 'callback' },
          { name: 'removeListener', rtype: 'promise' },
        ] }],
        nativeCallback: (_plugin: string, _method: string, options: { eventName: string }, cb: (value: unknown) => void) => {
          const id = String(++nextId);
          listeners.set(id, { name: options.eventName, cb }); return id;
        },
        nativePromise: async (_plugin: string, method: string, options: { callbackId?: string }) => {
          if (method === 'capabilities') return { speech: false, proximity: true };
          if (method === 'removeListener') { listeners.delete(options.callbackId!); return; }
          if (method === 'stop') { clearInterval(interval); return; }
          if (method === 'start') interval = setInterval(() => emit('audio', { at: Date.now(), sampleRate: 16000,
            samples: Array.from({ length: 1024 }, (_, i) => 0.12 * Math.sin(i * Math.PI * 2 * 2500 / 16000)) }), 64);
        },
      },
    });
  });
  await setup(page);
  await page.clock.install();
  await expect(page.locator('#sound-support')).toContainText('Proximity sensor available');
  await page.click('#sound-start');
  await expect(page.locator('#sound-status')).toContainText('Listening');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-near', { detail: true })));
  await page.clock.runFor(600);
  await expect(page.locator('#sound-pocket')).toContainText('recognition paused');
  await page.clock.runFor(2000);
  await expect(page.locator('#sound-status')).not.toContainText('Playing');
  await expect(page.locator('#sound-level')).toHaveAttribute('value', '0');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-near', { detail: false })));
  await page.clock.runFor(1000);
  await expect(page.locator('#sound-pocket')).toContainText('uncovered');
  await expect(page.locator('#sound-status')).toContainText('Playing Whistle');
  await page.clock.runFor(8000);
  await expect(page.locator('#sound-status')).toContainText('Previous content restored');
  await page.click('#sound-stop');
  await expect(page.locator('#sound-status')).toContainText('Microphone is off');
  await page.uncheck('#sound-pause-pocket');
  await expect(page.locator('#sound-start')).toBeEnabled();
  await page.click('#sound-start');
  await expect(page.locator('#sound-status')).toContainText('Listening');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-near', { detail: true })));
  await page.clock.runFor(600);
  await expect(page.locator('#sound-pocket')).toContainText('less reliable');
  await page.clock.runFor(1000);
  await expect(page.locator('#sound-status')).toContainText('Playing Whistle');
});
