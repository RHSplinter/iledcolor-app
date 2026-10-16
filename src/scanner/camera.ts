import type { IScannerControls } from '@zxing/browser';

export class QrCamera {
  private generation = 0;
  private stream?: MediaStream;
  private controls?: IScannerControls;

  stop() {
    this.generation++;
    this.controls?.stop();
    this.controls = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  async start(video: HTMLVideoElement, onResult: (text: string) => void, onError: (error: Error) => void) {
    this.stop();
    const generation = this.generation;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable. Use HTTPS or the native app, or enter QR data below.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) {
      if (generation !== this.generation) return;
      throw e;
    }
    if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    try {
      const [{ BrowserQRCodeReader }, { NotFoundException, ChecksumException, FormatException }] = await Promise.all([
        import('@zxing/browser'), import('@zxing/library'),
      ]);
      if (generation !== this.generation) return;
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromStream(stream, video, (result, error) => {
        if (generation !== this.generation) return;
        if (result) {
          const text = result.getText();
          this.stop();
          onResult(text);
        } else if (error && !(error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException)) {
          this.stop();
          onError(error);
        }
      });
      if (generation !== this.generation) controls.stop();
      else this.controls = controls;
    } catch (e) {
      if (generation !== this.generation) return;
      this.stop();
      throw e;
    }
  }
}
