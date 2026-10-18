/** MIME type for an upload, by extension; ChatGPT reads it from the File it receives. */
const TYPES: Readonly<Record<string, string>> = {
  zip: 'application/zip',
  pdf: 'application/pdf',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/x-python',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return TYPES[extension] ?? 'application/octet-stream';
}
