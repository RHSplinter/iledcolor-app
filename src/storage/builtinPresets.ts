import logo from '../assets/presets/xebia-logo.png?inline';
import copilotLogo from '../assets/presets/github-copilot-logo.png?inline';
import copilotHead from '../assets/presets/copilot-head.png?inline';
import copilotBlinkingHead from '../assets/presets/copilot-head-blinking.gif?inline';
import partyPopper from '../assets/presets/party-popper.gif?inline';
import rainbow from '../assets/presets/rainbow.gif?inline';
import nijanCat from '../assets/presets/nijan-cat.gif?inline';
import star from '../assets/presets/star.gif?inline';
import octocatAnimation from '../assets/presets/octocat-ani.gif?inline';
import copilotHeadAnimation from '../assets/presets/copilot-head-animation.gif?inline';
import type { ContentPreset } from './presets';

/** Bundled separately from personal presets so imports never remove the defaults. */
export function builtinPresets(): ContentPreset[] {
  return [
    {
      id: 'builtin-xebia-github', name: 'Xebia \u{1f49c} GitHub', updatedAt: 0,
      content: { kind: 'text', text: 'Xebia \u{1f49c} GitHub', fg: '#ffffff', bg: '#000000', speed: 3 },
    },
    {
      id: 'builtin-xebia-logo', name: 'Xebia logo', updatedAt: 0,
      content: { kind: 'image', dataUrl: logo, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-github-copilot-logo', name: 'GitHub Copilot logo', updatedAt: 0,
      content: { kind: 'image', dataUrl: copilotLogo, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-copilot-head', name: 'GitHub Copilot head', updatedAt: 0,
      content: { kind: 'image', dataUrl: copilotHead, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-copilot-blinking-head', name: 'GitHub Copilot head (blinking)', updatedAt: 0,
      content: { kind: 'image', dataUrl: copilotBlinkingHead, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-party-popper', name: 'Party Popper', updatedAt: 0,
      content: { kind: 'image', dataUrl: partyPopper, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-rainbow', name: 'Rainbow', updatedAt: 0,
      content: { kind: 'image', dataUrl: rainbow, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-nijan-cat', name: 'Nijan cat', updatedAt: 0,
      content: { kind: 'image', dataUrl: nijanCat, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-star', name: 'Star', updatedAt: 0,
      content: { kind: 'image', dataUrl: star, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-octocat-animation', name: 'Octocat animation', updatedAt: 0,
      content: { kind: 'image', dataUrl: octocatAnimation, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-copilot-head-animation', name: 'GitHub Copilot head (animated)', updatedAt: 0,
      content: { kind: 'image', dataUrl: copilotHeadAnimation, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-header', name: '<header>', updatedAt: 0,
      content: { kind: 'text', text: '<header>', fg: '#ffffff', bg: '#000000', speed: 3 },
    },
    {
      id: 'builtin-lgtm', name: 'LGTM \u{1f44d}', updatedAt: 0,
      content: { kind: 'text', text: 'LGTM \u{1f44d}', fg: '#ffffff', bg: '#000000', speed: 3 },
    },
  ];
}
