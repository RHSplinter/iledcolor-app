// Without a size hint many browsers default to 640x480, too coarse for the dense Universe badge QR.
export const BADGE_CAMERA_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

export class BadgeCamera {
  private generation = 0;
  private stream?: MediaStream;

  stop() {
    this.generation++;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  private async open(video: HTMLVideoElement, generation: number): Promise<MediaStream | undefined> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable. Use HTTPS or the native app, or enter scan data below.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: BADGE_CAMERA_VIDEO, audio: false });
    } catch (e) {
      if (generation !== this.generation) return undefined;
      throw e;
    }
    if (generation !== this.generation) { stream.getTracks().forEach((track) => track.stop()); return undefined; }
    this.stream = stream;
    video.srcObject = stream;
    await video.play();
    return stream;
  }

  async preview(video: HTMLVideoElement) {
    this.stop();
    const generation = this.generation;
    await this.open(video, generation);
  }
}
