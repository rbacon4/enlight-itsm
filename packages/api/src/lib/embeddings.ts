export interface EmbeddingKeyOverrides {
  anthropicApiKey?: string | undefined;
  voyageApiKey?: string | undefined;
  openAiApiKey?: string | undefined;
  embeddingProvider?: string | undefined;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

async function embedOpenAI(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: 'text-embedding-3-small', dimensions: 1536 }),
  });

  if (!resp.ok) throw new Error(`OpenAI Embeddings error ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as OpenAIEmbeddingResponse;
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function embedVoyage(texts: string[], apiKey: string): Promise<number[][]> {
  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: 'voyage-large-2' }),
  });

  if (!resp.ok) throw new Error(`Voyage Embeddings error ${resp.status}: ${await resp.text()}`);
  const json = (await resp.json()) as VoyageEmbeddingResponse;
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedTexts(texts: string[], overrides?: EmbeddingKeyOverrides): Promise<number[][]> {
  if (texts.length === 0) return [];

  const provider = overrides?.embeddingProvider
    ?? process.env['EMBEDDING_PROVIDER']
    ?? 'voyage';

  if (provider === 'openai') {
    const apiKey = overrides?.openAiApiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OpenAI API key not set. Add it in Settings → AI Keys or set OPENAI_API_KEY in your environment.');
    return embedOpenAI(texts, apiKey);
  }

  // Default: voyage
  const apiKey = overrides?.voyageApiKey ?? process.env['VOYAGE_API_KEY'];
  if (!apiKey) throw new Error('Voyage API key not set. Add it in Settings → AI Keys or set VOYAGE_API_KEY in your environment.');
  return embedVoyage(texts, apiKey);
}

export async function embedText(text: string, overrides?: EmbeddingKeyOverrides): Promise<number[]> {
  const results = await embedTexts([text], overrides);
  const first = results[0];
  if (!first) throw new Error('No embedding returned');
  return first;
}
