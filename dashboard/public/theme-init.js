// Runs before first paint (loaded from index.html) so there's no flash of the wrong theme.
try {
  var t = localStorage.getItem("tmg-theme");
  var dark = t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch (e) {}
