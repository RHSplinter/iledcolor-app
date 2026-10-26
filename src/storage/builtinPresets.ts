import logo from '../assets/presets/xebia-logo.png?inline';
import copilotLogo from '../assets/presets/github-copilot-logo.png?inline';
import partyPopper from '../assets/presets/party-popper.gif?inline';
import type { ContentPreset } from './presets';

/** Bundled separately from personal presets so imports never remove the defaults. */
export function builtinPresets(): ContentPreset[] {
  return [
    {
      id: 'builtin-xebia-github', name: 'Xebia \u{1f49c} GitHub', updatedAt: 0,
      content: { kind: 'text', text: 'Xebia \u{1f49c} GitHub', fg: '#ffffff', bg: '#000000', speed: 5 },
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
      id: 'builtin-party-popper', name: 'Party Popper', updatedAt: 0,
      content: { kind: 'image', dataUrl: partyPopper, fit: 'contain', bg: '#000000' },
    },
    {
      id: 'builtin-header', name: '<header>', updatedAt: 0,
      content: { kind: 'text', text: '<header>', fg: '#ffffff', bg: '#000000', speed: 5 },
    },
    {
      id: 'builtin-lgtm', name: 'LGTM \u{1f44d}', updatedAt: 0,
      content: { kind: 'text', text: 'LGTM \u{1f44d}', fg: '#ffffff', bg: '#000000', speed: 5 },
    },
  ];
}
