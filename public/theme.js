// Pick the theme before the page paints, so there is no flash.
(function () {
  try {
    var choice = localStorage.getItem('kroog-theme') || 'system';
    var dark = choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {}
})();
