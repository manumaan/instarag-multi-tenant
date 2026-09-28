/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: the app is served from S3 behind CloudFront with no server
  // side, so every route has to be a file that exists at build time.
  output: 'export',
  // No Next image optimiser without a server; frames are already resized to
  // 720px by the extractor.
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
