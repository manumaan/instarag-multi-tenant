import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({});

/** Titan Multimodal Embeddings: text, image, or both in one vector. */
export const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID ?? 'amazon.titan-embed-image-v1';
export const EMBEDDING_DIMENSION = Number(process.env.EMBEDDING_DIMENSION ?? 1024);

/** Titan rejects text beyond its limit, so long OCR plus description is trimmed. */
const MAX_INPUT_CHARS = 2000;

export function trimForEmbedding(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_INPUT_CHARS ? collapsed.slice(0, MAX_INPUT_CHARS) : collapsed;
}

export async function embed(input: { text?: string; imageBase64?: string }): Promise<number[]> {
  const body: Record<string, unknown> = {
    embeddingConfig: { outputEmbeddingLength: EMBEDDING_DIMENSION },
  };
  const text = input.text ? trimForEmbedding(input.text) : undefined;
  if (text) body.inputText = text;
  if (input.imageBase64) body.inputImage = input.imageBase64;
  if (!body.inputText && !body.inputImage) throw new Error('embed needs text or an image');

  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBEDDING_MODEL_ID,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const parsed = JSON.parse(Buffer.from(response.body).toString('utf8')) as {
    embedding?: number[];
    message?: string;
  };
  if (!parsed.embedding) throw new Error(`embedding model returned no vector: ${parsed.message ?? 'unknown'}`);
  return parsed.embedding;
}
