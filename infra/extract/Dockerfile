# Keyframe extraction + reel download Lambda.
# One image, three handlers: the Lambda functions differ only by CMD.

# Pinned by digest so a rebuild can never pick up a different ffmpeg.
FROM mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 AS ffmpeg

FROM public.ecr.aws/lambda/nodejs:22 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
# Two self-contained CJS bundles, so the runtime image carries no node_modules.
RUN node_modules/.bin/esbuild src/index.ts src/download.ts src/thumbnail.ts \
      --bundle --platform=node --target=node22 --format=cjs \
      --outdir=dist

FROM public.ecr.aws/lambda/nodejs:22

# yt-dlp resolves the video URL behind a reel permalink. Pinned: Instagram
# changes its markup often, and a version bump is how that gets fixed.
ARG YT_DLP_VERSION=2026.8.19
# LD_LIBRARY_PATH override: this image puts Node's bundled OpenSSL ahead of the
# system one, and AL2023's python3 _ssl then fails to resolve COMP_get_type.
# Pointing Python at /usr/lib64 first gives it a working ssl module. Only the
# Python processes get this; the Node runtime keeps the image's own path.
ENV PY_LD_LIBRARY_PATH=/usr/lib64:/lib64
# python3.11, not the default python3: this image's python3 is 3.9, and yt-dlp
# dropped 3.9 after 2025.10.14, which is far too old to still parse Instagram.
RUN dnf install -y python3.11 python3.11-pip \
 && LD_LIBRARY_PATH=${PY_LD_LIBRARY_PATH} python3.11 -m pip install --no-cache-dir "yt-dlp==${YT_DLP_VERSION}" \
 && dnf clean all \
 && rm -rf /var/cache/dnf \
 && LD_LIBRARY_PATH=${PY_LD_LIBRARY_PATH} yt-dlp --version

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=build /build/dist/ ${LAMBDA_TASK_ROOT}/

# Only /tmp is writable at runtime, and yt-dlp/Python want somewhere to scribble.
ENV HOME=/tmp XDG_CACHE_HOME=/tmp

CMD ["index.handler"]
