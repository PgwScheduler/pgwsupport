export function fileKind(filename) {
  const ext = (filename.split(".").pop() || "").toUpperCase();
  return ext && ext !== filename.toUpperCase() ? ext : "FILE";
}

export function sanitizeFilename(filename) {
  return filename.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "");
}
