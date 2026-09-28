import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

/** OpenSearch Serverless data-plane calls are SigV4-signed against `aoss`. */
export function openSearchClient(): Client {
  return new Client({
    ...AwsSigv4Signer({
      region: process.env.AWS_REGION!,
      service: 'aoss',
      getCredentials: () => defaultProvider()(),
    }),
    node: process.env.SEARCH_ENDPOINT!,
  });
}

export const INDEX_NAME = process.env.SEARCH_INDEX ?? 'frames';

/**
 * One document per citable moment. A frame carries what is visible and the text
 * read off it; a speech segment carries what was said. Both are keyed by ts_ms
 * so either can be cited and the player can seek to it.
 */
export type DocumentKind = 'frame' | 'speech';

export interface IndexedDocument {
  media_id: string;
  ts_ms: number;
  kind: DocumentKind;
  description: string;
  ocr_text: string;
  speech: string;
  caption: string;
  places: string;
  taken_at?: string;
  end_ms?: number;
  embedding: number[];
}

/** Frame and speech documents can share a timestamp, so the kind is in the id. */
export const documentId = (mediaId: string, tsMs: number, kind: DocumentKind = 'frame') =>
  kind === 'frame' ? `${mediaId}:${tsMs}` : `${mediaId}:${kind}:${tsMs}`;
