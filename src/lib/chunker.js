/**
 * lib/chunker.js — File ingestion and text chunking
 *
 * Strategy:
 *  - Target ~400 tokens per chunk (≈1600 chars at 4 chars/token)
 *  - 10% overlap to preserve cross-chunk context
 *  - Smart splitting: prefer natural boundaries (paragraphs, function defs)
 *  - Handles: .md, .txt, .js, .ts, .py, .json, .html, .css
 */

const CHUNK_TARGET_CHARS = 1600;
const OVERLAP_CHARS      = 160;

// ─── Extension → parser mapping ──────────────────────────────────────────────
const PARSERS = {
  '.md':   parseMarkdown,
  '.txt':  parsePlain,
  '.js':   parseCode,
  '.ts':   parseCode,
  '.jsx':  parseCode,
  '.tsx':  parseCode,
  '.py':   parseCode,
  '.json': parseJSON,
  '.html': parseHTML,
  '.css':  parsePlain,
  '.yaml': parsePlain,
  '.yml':  parsePlain,
};

/**
 * Ingest an array of { name, content } file objects and return a flat array
 * of chunk records ready for triplet extraction.
 *
 * @param {Array<{name: string, content: string, type?: string}>} files
 * @returns {Array<{text: string, source: string, chunkIndex: number, totalChunks: number}>}
 */
export function chunkFiles(files) {
  const allChunks = [];

  for (const file of files) {
    const ext    = getExtension(file.name);
    const parser = PARSERS[ext] ?? parsePlain;
    const text   = parser(file.content, file.name);
    const chunks = splitIntoChunks(text);

    chunks.forEach((chunk, idx) => {
      allChunks.push({
        text:        chunk,
        source:      file.name,
        chunkIndex:  idx,
        totalChunks: chunks.length,
      });
    });
  }

  return allChunks;
}

// ─── Format-specific pre-processors ──────────────────────────────────────────
function parseMarkdown(content) {
  // Keep headers and content; strip HTML tags
  return content
    .replace(/<[^>]+>/g, '')
    .replace(/```[\s\S]*?```/g, (block) => block) // preserve code blocks as-is
    .trim();
}

function parsePlain(content) {
  return content.trim();
}

function parseCode(content, filename) {
  // Prefix with filename for context
  return `// File: ${filename}\n${content.trim()}`;
}

function parseJSON(content, filename) {
  try {
    // Pretty-print for better token efficiency in extraction prompts
    const parsed = JSON.parse(content);
    return `// JSON: ${filename}\n${JSON.stringify(parsed, null, 2)}`;
  } catch {
    return `// JSON (parse error): ${filename}\n${content.trim()}`;
  }
}

function parseHTML(content) {
  // Strip tags, keep text content
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Core splitter ────────────────────────────────────────────────────────────
function splitIntoChunks(text) {
  if (text.length <= CHUNK_TARGET_CHARS) return [text];

  const chunks = [];
  let start    = 0;

  while (start < text.length) {
    let end = start + CHUNK_TARGET_CHARS;

    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // Walk back to a natural boundary
    end = findNaturalBreak(text, end);
    chunks.push(text.slice(start, end));

    // Advance with overlap
    start = Math.max(start + 1, end - OVERLAP_CHARS);
  }

  return chunks.filter((c) => c.trim().length > 20);
}

/**
 * Find the nearest natural break ≤ pos, in priority order:
 *  1. Double newline (paragraph)
 *  2. Single newline
 *  3. Sentence end (. ! ?)
 *  4. Word boundary
 */
function findNaturalBreak(text, pos) {
  const window = Math.min(200, pos); // look-back window

  // 1. Paragraph boundary
  const para = text.lastIndexOf('\n\n', pos);
  if (para > pos - window && para > 0) return para + 2;

  // 2. Newline
  const nl = text.lastIndexOf('\n', pos);
  if (nl > pos - window && nl > 0) return nl + 1;

  // 3. Sentence end
  const sent = Math.max(
    text.lastIndexOf('. ', pos),
    text.lastIndexOf('! ', pos),
    text.lastIndexOf('? ', pos),
  );
  if (sent > pos - window && sent > 0) return sent + 2;

  // 4. Word boundary
  const word = text.lastIndexOf(' ', pos);
  if (word > pos - window && word > 0) return word + 1;

  // Fallback: hard cut
  return pos;
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function getExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * Read a FileSystemDirectoryHandle recursively and return file objects.
 * Called from the Dashboard UI.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string[]} [allowedExtensions]
 * @returns {Promise<Array<{name: string, content: string}>>}
 */
export async function readDirectoryHandle(dirHandle, allowedExtensions = Object.keys(PARSERS)) {
  const files = [];
  await walkDir(dirHandle, dirHandle.name, files, allowedExtensions);
  return files;
}

async function walkDir(handle, basePath, files, allowed) {
  for await (const [name, entry] of handle.entries()) {
    const fullPath = `${basePath}/${name}`;
    if (entry.kind === 'directory') {
      // Skip hidden dirs and node_modules
      if (!name.startsWith('.') && name !== 'node_modules' && name !== 'dist') {
        await walkDir(entry, fullPath, files, allowed);
      }
    } else if (entry.kind === 'file') {
      const ext = getExtension(name);
      if (allowed.includes(ext)) {
        const file    = await entry.getFile();
        const content = await file.text();
        files.push({ name: fullPath, content });
      }
    }
  }
}
