import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import type { PlanSection } from './plan';

const MEDIA_TABLE = process.env.MEDIA_TABLE!;

export interface Source {
  media_id: string;
  type?: string;
  uploader?: string;
  caption?: string;
  slide_count?: number;
}

/**
 * A plan cites a dozen clips, and "b77bd0ee @ 3000ms" identifies none of them.
 * One BatchGet turns the ids into something a reader recognises.
 */
export async function sourcesFor(mediaIds: string[]): Promise<Source[]> {
  if (mediaIds.length === 0) return [];
  const fetched = await ddb.send(
    new BatchGetCommand({
      RequestItems: {
        [MEDIA_TABLE]: {
          Keys: mediaIds.map((id) => ({ id })),
          ProjectionExpression: 'id, #type, uploader, caption_normalized, slide_count',
          ExpressionAttributeNames: { '#type': 'type' },
        },
      },
    }),
  );
  return (fetched.Responses?.[MEDIA_TABLE] ?? []).map((row) => ({
    media_id: String(row.id),
    type: row.type ? String(row.type) : undefined,
    uploader: row.uploader ? String(row.uploader) : undefined,
    caption: row.caption_normalized ? String(row.caption_normalized).slice(0, 140) : undefined,
    slide_count: typeof row.slide_count === 'number' ? row.slide_count : undefined,
  }));
}

/** Flattened for the thread history, which stores a message as text. */
export function planToText(
  title: string,
  overview: string,
  sections: PlanSection[],
  gaps: string[],
): string {
  const lines = [title, '', overview];
  for (const section of sections) {
    lines.push('', section.heading);
    for (const item of section.items) lines.push(`- ${item.text}`);
  }
  if (gaps.length > 0) {
    lines.push('', 'Not covered by your clips:');
    for (const gap of gaps) lines.push(`- ${gap}`);
  }
  return lines.join('\n');
}
