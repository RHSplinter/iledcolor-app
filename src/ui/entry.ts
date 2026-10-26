if (new URLSearchParams(location.search).has('hatConnection')) {
  void import('./connectionTab').then(({ startConnectionTab }) => startConnectionTab());
} else {
  void import('./main');
}
