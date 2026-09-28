import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { IMAGE_SIZE } from './phash';

export const FFMPEG = process.env.FFMPEG_PATH ?? '/usr/local/bin/ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? '/usr/local/bin/ffprobe';

/** Longest edge, per the keyframe spec. */
const LONGEST_EDGE = 720;
/** -2 keeps the short edge even (chroma alignment), so it can round up by a pixel. */
/** mjpeg has no 0-100 quality scale; q:v 5 is the closest stop to JPEG q80. */
const JPEG_QSCALE = '5';
/**
 * JPEG is a full-range format and ffmpeg's mjpeg encoder refuses limited-range
 * input outright: a real reel arrived as VP9 yuv420p(tv, bt709) and every frame
 * command died with "Non full-range YUV is non-standard" ->
 * "ff_frame_thread_encoder_init failed". Naming the full-range pixel format
 * makes ffmpeg convert instead of refusing, and is harmless when the source is
 * already full range.
 */
const JPEG_PIX_FMT = 'yuvj420p';
const SCALE_FILTER = `scale=w='if(gt(iw,ih),${LONGEST_EDGE},-2)':h='if(gt(iw,ih),-2,${LONGEST_EDGE})'`;

/**
 * Slides get more pixels than keyframes: 1568 on the long edge.
 *
 * A keyframe is skimmed for what it shows, and 720 comes from a 720p video
 * anyway. A carousel slide is usually read — a list, a recipe, a set of tips —
 * and arrives as a 3000px original, so 720 would throw away the body text the
 * post is made of. 1568 is where Claude's vision downsizes an image regardless,
 * so it is the most detail the model can use and the least we can discard.
 */
const SLIDE_LONGEST_EDGE = 1568;
/**
 * min(), so a slide smaller than the cap is left alone. Upscaling it would cost
 * tokens for pixels carrying no more information than the original had.
 */
const SLIDE_SCALE_FILTER =
  `scale=w='if(gt(iw,ih),min(iw,${SLIDE_LONGEST_EDGE}),-2)':h='if(gt(iw,ih),-2,min(ih,${SLIDE_LONGEST_EDGE}))'`;

export function run(
  bin: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ? { ...process.env, ...env } : process.env,
    });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve({ stdout: Buffer.concat(stdout), stderr })
        : reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-2000)}`)),
    );
  });
}

export interface Probe {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export async function probe(input: string): Promise<Probe> {
  // All streams, not just v:0, so the audio track can be detected in one pass.
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,width,height:format=duration',
    '-of', 'json',
    input,
  ]);
  const parsed = JSON.parse(stdout.toString('utf8')) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video');
  if (!video?.width || !video?.height) throw new Error('input has no decodable video stream');
  return {
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    width: video.width,
    height: video.height,
    hasAudio: parsed.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
  };
}

export interface ExtractedFrame {
  tsMs: number;
  file: string;
}

/** Writes one resized JPEG at an exact timestamp. Used for the cover and for even sampling. */
export async function frameAt(input: string, tsMs: number, outFile: string): Promise<ExtractedFrame> {
  await run(FFMPEG, [
    '-nostdin', '-y',
    '-ss', (tsMs / 1000).toFixed(3),
    '-i', input,
    '-frames:v', '1',
    '-vf', SCALE_FILTER,
    '-q:v', JPEG_QSCALE,
    '-pix_fmt', JPEG_PIX_FMT,
    outFile,
  ]);
  return { tsMs, file: outFile };
}

/** Resizes a still image (a screenshot upload) into the same JPEG shape as a keyframe. */
export async function convertStill(input: string, outFile: string): Promise<ExtractedFrame> {
  await run(FFMPEG, [
    '-nostdin', '-y',
    '-i', input,
    '-vf', SCALE_FILTER,
    '-q:v', JPEG_QSCALE,
    '-pix_fmt', JPEG_PIX_FMT,
    outFile,
  ]);
  return { tsMs: 0, file: outFile };
}

/**
 * The library grid's image: 520px on the long edge.
 *
 * The grid draws tiles at roughly 200-260px, so 520 covers a 2x screen and
 * nothing more. It exists because the grid was presigning the cover *frame* —
 * 720px for a reel and 1568px for a carousel slide, the latter sized for the
 * vision pass to read body text off it. Fourteen tiles came to 1.22 MB.
 */
const THUMB_LONGEST_EDGE = 520;
const THUMB_SCALE_FILTER =
  `scale=w='if(gt(iw,ih),min(iw,${THUMB_LONGEST_EDGE}),-2)':h='if(gt(iw,ih),-2,min(ih,${THUMB_LONGEST_EDGE}))'`;

/** Downscales a cover frame for the library grid. Never upscales a small one. */
export async function convertThumbnail(input: string, outFile: string): Promise<void> {
  await run(FFMPEG, [
    '-nostdin', '-y',
    '-i', input,
    '-vf', THUMB_SCALE_FILTER,
    '-q:v', JPEG_QSCALE,
    '-pix_fmt', JPEG_PIX_FMT,
    outFile,
  ]);
}

/** Re-encodes a carousel slide fetched from Instagram's CDN into a frame JPEG. */
export async function convertSlide(input: string, outFile: string): Promise<void> {
  await run(FFMPEG, [
    '-nostdin', '-y',
    '-i', input,
    '-vf', SLIDE_SCALE_FILTER,
    '-q:v', JPEG_QSCALE,
    '-pix_fmt', JPEG_PIX_FMT,
    outFile,
  ]);
}

/** showinfo prints one line per emitted frame; pts_time is that frame's timestamp. */
export function parseShowinfoTimestamps(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
}

/**
 * Scene-cut detection per the spec: keep frames where the scene score exceeds
 * the threshold, resized and JPEG-encoded. Returns them in timestamp order.
 */
export async function extractSceneFrames(
  input: string,
  outDir: string,
  sceneThreshold: number,
): Promise<ExtractedFrame[]> {
  const { stderr } = await run(FFMPEG, [
    '-nostdin', '-y',
    '-i', input,
    '-vf', `select='gt(scene,${sceneThreshold})',${SCALE_FILTER},showinfo`,
    '-vsync', 'vfr',
    '-q:v', JPEG_QSCALE,
    '-pix_fmt', JPEG_PIX_FMT,
    path.join(outDir, 'scene-%04d.jpg'),
  ]);

  const timestamps = parseShowinfoTimestamps(stderr);
  const files = (await readdir(outDir)).filter((f) => f.startsWith('scene-')).sort();

  // showinfo lines and output files are emitted in the same order; zip them and
  // ignore any tail mismatch rather than mislabelling timestamps.
  return files.slice(0, timestamps.length).map((file, i) => ({
    tsMs: timestamps[i],
    file: path.join(outDir, file),
  }));
}

/** Decodes a JPEG down to the 32x32 grayscale plane the perceptual hash wants. */
export async function grayscalePlane(file: string): Promise<Uint8Array> {
  const { stdout } = await run(FFMPEG, [
    '-nostdin',
    '-i', file,
    '-vf', `scale=${IMAGE_SIZE}:${IMAGE_SIZE}:flags=area,format=gray`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-',
  ]);
  return new Uint8Array(stdout.subarray(0, IMAGE_SIZE * IMAGE_SIZE));
}

export const readFrame = (file: string) => readFile(file);

/**
 * Extracts the speech track for transcription: mono 16 kHz, which is what
 * Amazon Transcribe wants and a fraction of the size of the original.
 */
export async function extractAudio(input: string, outFile: string): Promise<void> {
  await run(FFMPEG, [
    '-nostdin', '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'aac',
    '-b:a', '64k',
    outFile,
  ]);
}
