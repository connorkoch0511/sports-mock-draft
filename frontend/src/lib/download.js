/**
 * Hand the browser a string to save as a file.
 *
 * Lived inside Results.jsx until the board export needed it too. A second
 * copy is how two downloads start behaving differently for no reason.
 */
export function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
