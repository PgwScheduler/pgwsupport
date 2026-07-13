export const csvEsc = (v) => {
  const t = String(v ?? "");
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

export function downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
