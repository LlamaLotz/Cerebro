#!/usr/bin/env bash
set -e

echo "Installing System Dependencies (FFmpeg & Tkinter)..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y ffmpeg python3-tk
elif command -v dnf &> /dev/null; then
    sudo dnf install -y ffmpeg python3-tkinter
elif command -v pacman &> /dev/null; then
    sudo pacman -S --noconfirm ffmpeg python-tk
fi

echo "Upgrading pip..."
python3 -m pip install --upgrade pip

echo "Installing Python Libraries..."
python3 -m pip install --upgrade \
    yt-dlp \
    faster-whisper \
    torch \
    crawl4ai \
    docling \
    omniroute \
    tqdm

echo "Setting up Playwright for Crawl4AI..."
python3 -m playwright install chromium

echo "Linux setup complete! Run: python3 master_extractor.py"