import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});

/**
 * Starts the extractor's container while the download is still running.
 *
 * Reels arrive hours apart, so the extractor is cold on almost every ingest:
 * measured ~0.8s from Step Functions' invoke to its handler starting. A download
 * takes 4-8s, so an async no-op fired here has the container up and idle before
 * the pipeline reaches Extract. The warm call must return at once; one still
 * running when the real call lands would push that onto a second, cold container.
 *
 * Fire and forget: a failed warm-up costs nothing but the ~0.8s it meant to save.
 */
export function warmExtractor(): void {
  const functionName = process.env.EXTRACT_FUNCTION_NAME;
  if (!functionName) return;
  lambda
    .send(new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: Buffer.from('{"warm":true}') }))
    .catch((err) => console.warn('extractor warm-up failed', { error: (err as Error).message }));
}
