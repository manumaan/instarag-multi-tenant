#!/usr/bin/env bash
# Builds an installable release APK named after its version:
#   ~/Downloads/ReelLens-<version>.apk
#
# Every APK handed out gets a new version, set in mobile/app.json before running this:
#   expo.version              what people see — minor for features, patch for fixes
#   expo.android.versionCode  must go up by one every build: Android refuses to
#                             install an "update" whose versionCode is not higher
#   expo.ios.buildNumber      kept in step with versionCode
#
# It refuses to overwrite an APK of the same version, so a forgotten bump fails
# here rather than producing two different files with one version number.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE="$ROOT/mobile"
read -r VERSION CODE < <(python3 -c "import json; e=json.load(open('$MOBILE/app.json'))['expo']; print(e['version'], e['android']['versionCode'])")
OUT="${OUT_DIR:-$HOME/Downloads}/ReelLens-$VERSION.apk"

if [[ -e "$OUT" && "${FORCE:-0}" != 1 ]]; then
  echo "error: $OUT already exists — bump expo.version and expo.android.versionCode in mobile/app.json" >&2
  exit 1
fi

# React Native's native build needs JDK 17: newer JDKs print a warning its CMake
# step treats as a failure. Android Studio's bundled JDK is newer.
export JAVA_HOME="${JAVA_HOME_17:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NODE_ENV=production LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

echo "==> writing mobile/.env.local from the deployed stack"
"$ROOT/scripts/write-mobile-env.sh" >/dev/null

echo "==> regenerating android/ from app.json (icons, version, plugins)"
(cd "$MOBILE" && npx expo prebuild --platform android --clean >/dev/null)

echo "==> building ReelLens $VERSION (versionCode $CODE)"
(cd "$MOBILE/android" && ./gradlew assembleRelease --console=plain -q)

cp "$MOBILE/android/app/build/outputs/apk/release/app-release.apk" "$OUT"
echo "built: $OUT"
