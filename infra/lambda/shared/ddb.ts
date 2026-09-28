import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLES = {
  media: process.env.MEDIA_TABLE!,
  frames: process.env.FRAMES_TABLE!,
  saves: process.env.SAVES_TABLE!,
  usage: process.env.USAGE_TABLE!,
  jobs: process.env.JOBS_TABLE!,
};


export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : undefined;
}

export function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
