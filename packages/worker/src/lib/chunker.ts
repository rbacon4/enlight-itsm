export function chunkText(
  text: string,
  chunkSize: number,
  overlap: number,
  minChunkSize: number,
): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const paragraphs = normalized
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (current.length === 0) {
      current = para;
    } else if (current.length + para.length + 2 <= chunkSize) {
      current += '\n\n' + para;
    } else {
      if (current.length >= minChunkSize) chunks.push(current);
      const tail = current.slice(-overlap);
      current = tail ? tail + '\n\n' + para : para;
    }
  }

  if (current.length >= minChunkSize) chunks.push(current);

  return chunks.flatMap((chunk) =>
    chunk.length <= chunkSize ? [chunk] : splitLong(chunk, chunkSize, overlap, minChunkSize),
  );
}

function splitLong(
  text: string,
  chunkSize: number,
  overlap: number,
  minChunkSize: number,
): string[] {
  // Split at sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= chunkSize) {
      current += (current ? ' ' : '') + sentence;
    } else {
      if (current.length >= minChunkSize) chunks.push(current);
      const tail = current.slice(-overlap);
      current = tail ? tail + ' ' + sentence : sentence;
    }
  }

  if (current.length >= minChunkSize) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.slice(0, chunkSize)];
}
