#!/usr/bin/env bash
set -e

echo "Checking Homebrew for FFmpeg & Python 3.12..."
if ! command -v brew &> /dev/null; then
    echo "Homebrew not found. Install Homebrew first from https://brew.sh"
    exit 1
fi

brew install ffmpeg

if ! command -v python3.12 &> /dev/null; then
    echo "Python 3.12 not found. Installing python@3.12 via Homebrew..."
    brew install python@3.12
fi

echo "Configuring Rust targets for universal macOS builds (Intel + Apple Silicon)..."
if command -v rustup &> /dev/null; then
    rustup target add aarch64-apple-darwin x86_64-apple-darwin 2>/dev/null || true
fi

echo "Installing Python Libraries for Python 3.12..."
python3.12 -m pip install --break-system-packages --upgrade \
    yt-dlp \
    faster-whisper \
    torch \
    crawl4ai \
    docling \
    omniroute \
    tqdm

echo "Setting up Playwright for Crawl4AI..."
python3.12 -m playwright install chromium

echo "macOS setup complete! Run: python3.12 master_extractor.py"
