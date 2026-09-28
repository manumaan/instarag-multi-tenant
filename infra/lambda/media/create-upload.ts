import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, MEDIA_ENTITY } from '../shared/ddb';
import { badRequest, handler, parseJsonBody } from '../shared/http';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  slideTsMs,
  type MediaRecord,
} from '../shared/media';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const URL_TTL_SECONDS = 900;

interface Slide {
  filename?: string;
  contentType?: string;
  bytes?: number;
}

interface Body extends Slide {
  /**
   * Several images uploaded as one carousel rather than as separate posts.
   * A carousel is one record whose frames are its slides, so the whole post is
   * analysed together and Ask can reason across it.
   */
  slides?: Slide[];
}

/**
 * POST /uploads — reserve a media id and hand back presigned PUT URLs.
 *
 * One file is a reel or a single image; `slides` is a carousel, which gets one
 * media id and one presigned URL per slide.
 */
export const main = handler(async (event) => {
  const body = parseJsonBody<Body>(event);
  if (body.slides) return createCarousel(body.slides);

  const contentType = body.contentType?.toLowerCase();
  if (!contentType) throw badRequest('contentType is required');
  const spec = ALLOWED_CONTENT_TYPES[contentType];
  if (!spec) {
    throw badRequest(`unsupported contentType ${contentType}; allowed: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}`);
  }
  if (typeof body.bytes !== 'number' || body.bytes <= 0) throw badRequest('bytes must be a positive number');
  if (body.bytes > MAX_UPLOAD_BYTES) throw badRequest(`file exceeds the ${MAX_UPLOAD_BYTES} byte limit`);

  const id = randomUUID();
  const s3Key = `media/${id}/original${spec.ext}`;

  const record: MediaRecord = {
    id,
    entity: MEDIA_ENTITY,
    source: 'upload',
    type: spec.type,
    status: 'awaiting_upload',
    created_at: new Date().toISOString(),
    s3_key: s3Key,
    content_type: contentType,
    bytes: body.bytes,
    original_filename: body.filename?.slice(0, 256),
  };
  await ddb.send(new PutCommand({ TableName: TABLES.media, Item: record }));

  // signableHeaders puts content-type in SignedHeaders, so S3 rejects a PUT
  // that sends anything else. Without it the presigner signs host alone and the
  // URL would accept an object of any type under our key.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
  );

  return { mediaId: id, s3Key, uploadUrl, expiresIn: URL_TTL_SECONDS, media: record };
});

const MAX_SLIDES = 20;

async function createCarousel(slides: Slide[]) {
  if (slides.length === 0) throw badRequest('slides must not be empty');
  if (slides.length > MAX_SLIDES) throw badRequest(`a carousel may have at most ${MAX_SLIDES} slides`);

  const specs = slides.map((slide, index) => {
    const contentType = slide.contentType?.toLowerCase();
    if (!contentType) throw badRequest(`slide ${index + 1} has no contentType`);
    const spec = ALLOWED_CONTENT_TYPES[contentType];
    // Images only: a video among the slides is a different kind of post and
    // would need the extraction pipeline, not the slide path.
    if (!spec || !contentType.startsWith('image/')) {
      throw badRequest(`slide ${index + 1} must be an image; got ${contentType}`);
    }
    if (typeof slide.bytes !== 'number' || slide.bytes <= 0) {
      throw badRequest(`slide ${index + 1} needs a positive bytes`);
    }
    if (slide.bytes > MAX_UPLOAD_BYTES) throw badRequest(`slide ${index + 1} is too large`);
    return { contentType, spec, filename: slide.filename };
  });

  const id = randomUUID();
  const record: MediaRecord = {
    id,
    entity: MEDIA_ENTITY,
    source: 'upload',
    type: 'carousel',
    status: 'awaiting_upload',
    created_at: new Date().toISOString(),
    content_type: 'image/carousel',
    slide_count: specs.length,
    bytes: slides.reduce((total, slide) => total + (slide.bytes ?? 0), 0),
    original_filename: specs[0].filename?.slice(0, 256),
  };
  await ddb.send(new PutCommand({ TableName: TABLES.media, Item: record }));

  const uploads = await Promise.all(
    specs.map(async ({ contentType, spec }, index) => {
      // Slides land where frames live, because that is what they become.
      const key = `media/${id}/frames/${String(slideTsMs(index)).padStart(8, '0')}${spec.ext}`;
      return {
        index,
        s3Key: key,
        contentType,
        uploadUrl: await getSignedUrl(
          s3,
          new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
          { expiresIn: URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
        ),
      };
    }),
  );

  return { mediaId: id, slides: uploads, expiresIn: URL_TTL_SECONDS, media: record };
}
