/**
 * lib/chunker.js — File ingestion and text chunking
 * Namespace field added for graph edge weighting.
 */

const CHUNK_TARGET_CHARS = 1600;
const OVERLAP_CHARS      = 160;

const PARSERS = {
  '.md':   parseMarkdown, '.txt':  parsePlain,
  '.js':   parseCode,     '.ts':   parseCode,
  '.jsx':  parseCode,     '.tsx':  parseCode,
  '.py':   parseCode,     '.json': parseJSON,
  '.html': parseHTML,     '.css':  parsePlain,
  '.yaml': parsePlain,    '.yml':  parsePlain,
};

export function chunkFiles(files) {
  const allChunks = [];
  for (const file of files) {
    const ext    = getExtension(file.name);
    const parser = PARSERS[ext] ?? parsePlain;
    const text   = parser(file.content, file.name);
    const chunks = splitIntoChunks(text);

    const parts     = file.name.replace(/\\/g, '/').split('/');
    const namespace = parts.length > 2 ? parts.slice(0, -1).join('/') : parts[0];

    chunks.forEach((chunk, idx) => {
      allChunks.push({
        text, source: file.name, namespace,
        chunkIndex: idx, totalChunks: chunks.length,
      });
    });
  }
  return allChunks;
}

function parseMarkdown(content) {
  return content.replace(/<[^>]+>/g, '').trim();
}
function parsePlain(content) { return content.trim(); }
function parseCode(content, filename) { return `// File: ${filename}\n${content.trim()}`; }
function parseJSON(content, filename) {
  try { return `// JSON: ${filename}\n${JSON.stringify(JSON.parse(content), null, 2)}`; }
  catch { return `// JSON (parse error): ${filename}\n${content.trim()}`; }
}
function parseHTML(content) {
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function splitIntoChunks(text) {
  if (text.length <= CHUNK_TARGET_CHARS) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + CHUNK_TARGET_CHARS;
    if (end >= text.length) { chunks.push(text.slice(start)); break; }
    end = findNaturalBreak(text, end);
    chunks.push(text.slice(start, end));
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }
  return chunks.filter((c) => c.trim().length > 20);
}

function findNaturalBreak(text, pos) {
  const window = Math.min(200, pos);
  const para = text.lastIndexOf('\n\n', pos);
  if (para > pos - window && para > 0) return para + 2;
  const nl = text.lastIndexOf('\n', pos);
  if (nl > pos - window && nl > 0) return nl + 1;
  const sent = Math.max(text.lastIndexOf('. ', pos), text.lastIndexOf('! ', pos), text.lastIndexOf('? ', pos));
  if (sent > pos - window && sent > 0) return sent + 2;
  const word = text.lastIndexOf(' ', pos);
  if (word > pos - window && word > 0) return word + 1;
  return pos;
}

function getExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

export async function readDirectoryHandle(dirHandle, allowedExtensions = Object.keys(PARSERS)) {
  const files = [];
  await walkDir(dirHandle, dirHandle.name, files, allowedExtensions);
  return files;
}

async function walkDir(handle, basePath, files, allowed) {
  for await (const [name, entry] of handle.entries()) {
    const fullPath = `${basePath}/${name}`;
    if (entry.kind === 'directory') {
      if (!name.startsWith('.') && name !== 'node_modules' && name !== 'dist') {
        await walkDir(entry, fullPath, files, allowed);
      }
    } else if (entry.kind === 'file') {
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (allowed.includes(ext)) {
        const file    = await entry.getFile();
        const content = await file.text();
        files.push({ name: fullPath, content });
      }
    }
  }
}
