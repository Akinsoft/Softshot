#!/usr/bin/env bash
set -euo pipefail

ffmpeg_tag="n8.1.2"
nv_codec_headers_tag="n12.1.14.0"
amf_tag="v1.4.36"
debian_snapshot="20261016T000000Z"
prefix="/opt/ffbuild"
work="/tmp/ffbuild"
out="/out"

configure_flags=(
  --prefix="$prefix"
  --target-os=mingw32
  --arch=x86_64
  --cross-prefix=x86_64-w64-mingw32-
  --cc=x86_64-w64-mingw32-gcc-posix
  --cxx=x86_64-w64-mingw32-g++-posix
  --pkg-config=pkg-config
  --pkg-config-flags=--static
  --extra-cflags="-I$prefix/include"
  --extra-ldflags="-static -static-libgcc -static-libstdc++"
  --enable-static
  --disable-shared
  --disable-debug
  --disable-doc
  --disable-network
  --disable-autodetect
  --disable-everything
  --disable-ffplay
  --disable-ffprobe
  --enable-w32threads
  --enable-d3d11va
  --enable-ffnvcodec
  --enable-nvenc
  --enable-amf
  --enable-mediafoundation
  --enable-indev=lavfi
  --enable-filter=color,gfxcapture,format,null,scale,fps,trim
  --enable-decoder=wrapped_avframe
  --enable-encoder=h264_nvenc,h264_amf,h264_mf
  --enable-parser=h264
  --enable-bsf=extract_extradata
  --enable-muxer=mp4,null
  --enable-protocol=pipe,file
)

required_components=(
  CONFIG_GFXCAPTURE_FILTER
  CONFIG_H264_NVENC_ENCODER
  CONFIG_H264_AMF_ENCODER
  CONFIG_H264_MF_ENCODER
  CONFIG_MP4_MUXER
)

export DEBIAN_FRONTEND=noninteractive
rm -f /etc/apt/sources.list.d/debian.sources
echo "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$debian_snapshot sid main" > /etc/apt/sources.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates gcc git libc6-dev make nasm pkgconf \
  gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix mingw-w64-x86-64-dev >/dev/null

git -c advice.detachedHead=false clone -q --depth 1 --branch "$nv_codec_headers_tag" https://github.com/FFmpeg/nv-codec-headers.git "$work/nv-codec-headers"
make -s -C "$work/nv-codec-headers" PREFIX="$prefix" install

git -c advice.detachedHead=false clone -q --depth 1 --branch "$amf_tag" --filter=blob:none --sparse https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git "$work/amf"
git -C "$work/amf" sparse-checkout set amf/public/include
mkdir -p "$prefix/include/AMF"
cp -r "$work/amf/amf/public/include/." "$prefix/include/AMF/"

git -c advice.detachedHead=false clone -q --depth 1 --branch "$ffmpeg_tag" https://github.com/FFmpeg/FFmpeg.git "$work/ffmpeg"
cd "$work/ffmpeg"
PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure "${configure_flags[@]}"
for component in "${required_components[@]}"; do
  if ! grep -q "^#define $component 1" config_components.h; then
    echo "FFmpeg configure disabled $component" >&2
    exit 1
  fi
done
make -s -j"$(nproc)" ffmpeg.exe
x86_64-w64-mingw32-strip ffmpeg.exe

mkdir -p "$out"
cp ffmpeg.exe "$out/ffmpeg.exe"
cp COPYING.LGPLv2.1 "$out/LICENSE-FFmpeg.txt"
cp "$work/amf/LICENSE.txt" "$out/LICENSE-AMF.txt"
{
  echo "FFmpeg for Softshot Clips"
  echo
  echo "FFmpeg is licensed under the GNU Lesser General Public License version 2.1 or later (see LICENSE-FFmpeg.txt)."
  echo "This build contains no GPL or nonfree components."
  echo
  echo "Source code:"
  echo "  FFmpeg $ffmpeg_tag: https://github.com/FFmpeg/FFmpeg/tree/$ffmpeg_tag"
  echo "  nv-codec-headers $nv_codec_headers_tag (MIT): https://github.com/FFmpeg/nv-codec-headers/tree/$nv_codec_headers_tag"
  echo "  AMF headers $amf_tag (MIT, see LICENSE-AMF.txt): https://github.com/GPUOpen-LibrariesAndSDKs/AMF/tree/$amf_tag"
  echo "  Build script: scripts/ffmpeg/build.sh in https://github.com/akinsoft/Softshot"
  echo
  echo "Configure flags:"
  printf '  %s\n' "${configure_flags[@]}"
} > "$out/SOURCE.txt"
