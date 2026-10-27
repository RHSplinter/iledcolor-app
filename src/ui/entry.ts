import { isNativeApp } from '../platform';
const query = new URLSearchParams(location.search);
if (query.has('controller') || isNativeApp() || location.hash.includes('mock')) {
  window.name = 'iledcolor-led-hat-controller';
  if (!isNativeApp() && location.hash !== '#mock') {
    const canonical = new URL(location.href); canonical.search = '?controller=1';
    history.replaceState(null, '', canonical.href);
  }
  void import('./main');
} else {
  window.name = 'iledcolor-led-hat-connection';
  const canonical = new URL(location.href); canonical.search = '?hatConnection=1';
  history.replaceState(null, '', canonical.href);
  void import('./connectionTab').then(({ startConnectionTab }) => startConnectionTab());
}
