import os
import sys
import subprocess

# Self-Healing Environment: Check and auto-install core dependencies before importing them
def auto_heal_environment():
    # Modules to check
    # Maps: "import_module_name": "pip_package_name"
    standard_required = {
        "yt_dlp": "yt-dlp",
        "tqdm": "tqdm",
        "pypdf": "pypdf",
        "crawl4ai": "crawl4ai",
        "faster_whisper": "faster-whisper",
        "docling": "docling",
        "pandas": "pandas",
        "numpy": "numpy",
        "PIL": "Pillow",
        "cv2": "opencv-python",
        "rapidocr": "rapidocr-plugin-openvino",
        "pydantic_settings": "pydantic-settings",
        "typer": "typer",
    }
    
    missing_standard = []
    for module_name, package_name in standard_required.items():
        try:
            __import__(module_name)
        except ImportError:
            missing_standard.append(package_name)
            
    # Torch check
    missing_torch = False
    try:
        import torch
    except ImportError:
        missing_torch = True
            
    if missing_standard or missing_torch:
        print(f"\n[Cerebro Self-Healing] Environment needs repair.")
        try:
            # Upgrade pip first
            subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", "pip"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # Install Standard Packages
            if missing_standard:
                print(f"Installing missing packages: {missing_standard}")
                subprocess.check_call([sys.executable, "-m", "pip", "install", *missing_standard])
            
            # Install Torch Packages
            if missing_torch:
                print("Installing torch, torchvision, torchaudio (this may take a while)...")
                subprocess.check_call([
                    sys.executable, "-m", "pip", "install", 
                    "torch", "torchvision", "torchaudio"
                ])
                
            print("[Cerebro Self-Healing] Environment repaired! Restarting script...\n")
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            print(f"[Cerebro Self-Healing ERROR] Failed to auto-install: {e}")
            print("Please install these packages manually.\n")

auto_heal_environment()

import re
import json
import time
import gc
import shutil
import urllib.request
import concurrent.futures
import argparse
import logging
from datetime import datetime
from pathlib import Path
import tkinter as tk
from tkinter import filedialog
import yt_dlp

# Lazy-load docling to prevent crashes during auto-healing
def get_docling_imports():
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.datamodel.base_models import InputFormat
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend
    return DocumentConverter, PdfFormatOption, PdfPipelineOptions, InputFormat, PyPdfiumDocumentBackend


# Suppress non-critical warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TORCH_COMPILE_DISABLE"] = "1"
os.environ["TORCHDYNAMO_DISABLE"] = "1"

from tqdm import tqdm
from pypdf import PdfReader, PdfWriter

# Crawl4AI Import
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

# ==========================================
# 1. SETUP BASE PATHS & ENGINE LOADERS
# ==========================================

SCRIPT_DIR = Path(__file__).parent.resolve()
OUTPUT_DIR = SCRIPT_DIR / "cerebro_output"
DOWNLOADS_DIR = SCRIPT_DIR / "downloads"
LOGS_DIR = SCRIPT_DIR / "logs"


class TeeStream:
    """Duplicates stdout/stderr to a timestamped log file in the logs directory."""
    def __init__(self, original_stream, log_file):
        self.terminal = original_stream
        self.log_file = log_file

    def write(self, message):
        self.terminal.write(message)
        if message:
            clean_msg = message.replace('\r', '')
            if clean_msg:
                try:
                    with open(self.log_file, "a", encoding="utf-8") as f:
                        f.write(clean_msg)
                except Exception:
                    pass

    def flush(self):
        self.terminal.flush()

    def isatty(self):
        return getattr(self.terminal, 'isatty', lambda: False)()


def setup_logging():
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    log_file = LOGS_DIR / f"cerebro_{timestamp}.log"
    
    # Redirect stdout and stderr so ALL prints, logs, and errors are captured
    sys.stdout = TeeStream(sys.__stdout__, log_file)
    sys.stderr = TeeStream(sys.__stderr__, log_file)
    
    print(f"==================================================")
    print(f"CEREBRO INGESTION PIPELINE LOG")
    print(f"Date/Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"Log Destination: {log_file.resolve()}")
    print(f"==================================================\n")
    
    # Configure the standard logger
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_file, encoding='utf-8'),
            logging.StreamHandler(sys.__stdout__)  # Log directly to raw stdout to avoid Tee duplication
        ]
    )
    
    return logging.getLogger("Cerebro")

WHISPER_MODEL = None
CONVERTER_NO_OCR = None
CONVERTER_WITH_OCR = None

def get_whisper():
    """Lazy loader for Faster-Whisper."""
    global WHISPER_MODEL
    if WHISPER_MODEL is None:
        try:
            import torch
            from faster_whisper import WhisperModel
            print("Initializing Faster-Whisper local model...")
            device = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if torch.cuda.is_available() else "int8"
            WHISPER_MODEL = WhisperModel("small", device=device, compute_type=compute_type)
        except Exception as e:
            logger.error(f"CRITICAL: Cannot initialize transcription (missing torch/faster-whisper or build error): {e}")
            WHISPER_MODEL = False # Mark as permanently unavailable
    return WHISPER_MODEL if WHISPER_MODEL is not False else None

def get_docling(enable_ocr=False):
    """Lazy loader for Optimized Docling Engine."""
    global CONVERTER_NO_OCR, CONVERTER_WITH_OCR
    
    # Dynamically import docling components to prevent startup crashes
    DocumentConverter, PdfFormatOption, PdfPipelineOptions, InputFormat, PyPdfiumDocumentBackend = get_docling_imports()
    
    if enable_ocr:
        if CONVERTER_WITH_OCR is None:
            pipeline_options = PdfPipelineOptions()
            pipeline_options.generate_picture_images = False
            pipeline_options.generate_table_images = False
            pipeline_options.do_ocr = True # Enable OCR
    
            CONVERTER_WITH_OCR = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_options=pipeline_options,
                        backend=PyPdfiumDocumentBackend
                    )
                }
            )
        return CONVERTER_WITH_OCR
    else:
        if CONVERTER_NO_OCR is None:
            pipeline_options = PdfPipelineOptions()
            pipeline_options.generate_picture_images = False
            pipeline_options.generate_table_images = False
            pipeline_options.do_ocr = False # Disable OCR
    
            CONVERTER_NO_OCR = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_options=pipeline_options,
                        backend=PyPdfiumDocumentBackend
                    )
                }
            )
        return CONVERTER_NO_OCR


# Worker function for process pool execution
def _docling_worker(pdf_path: str, ocr_preference: str = "adaptive") -> str:
    # Pass 1: Try without OCR unless force-on
    docling_no_ocr = get_docling(enable_ocr=False)
    
    # If forced on, we skip the adaptive check and just use OCR
    if ocr_preference.lower() in ["on", "o"]:
        docling_ocr = get_docling(enable_ocr=True)
        res = docling_ocr.convert(pdf_path)
        return res.document.export_to_markdown()

    res = docling_no_ocr.convert(pdf_path)
    content = res.document.export_to_markdown()

    # If forced off, we don't try OCR at all. Otherwise, check content.
    if ocr_preference.lower() in ["adaptive", "a"]:
        # Calculate meaningful text content
        total_words = len(content.split())
        # Identify lines that are page markers (e.g., "Page 1", "page 31", "P. 1", "Page-1")
        marker_lines = re.findall(r'(?i)^\s*(page|p\.?)\s*[-.]?\s*\d+\s*$', content, flags=re.MULTILINE)
        
        # Count words contributed by markers
        marker_words = sum(len(line.split()) for line in marker_lines)
        
        # Meaningful content is total minus page markers
        meaningful_words = total_words - marker_words
        
        # Simple check: If meaningful content is too short, try OCR
        if meaningful_words < 50:
            logger.info(f"Low meaningful text content found in {pdf_path} ({meaningful_words} words). Retrying with OCR...")
            docling_ocr = get_docling(enable_ocr=True)
            res = docling_ocr.convert(pdf_path)
            content = res.document.export_to_markdown()
    
    return content


def safe_write_file(file_path: Path, content: str, encoding: str = "utf-8"):
    """Writes content to a local temp file first, then moves it to the final destination to avoid network share permission issues."""
    try:
        temp_dir = Path(os.environ.get("TEMP", "/tmp"))
        temp_file = temp_dir / f"cerebro_{int(time.time())}_{file_path.name}"
        
        with open(temp_file, "w", encoding=encoding) as f:
            f.write(content)
        
        # Ensure target directory exists
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Move temp file to final destination (overwrite if exists)
        shutil.move(str(temp_file), str(file_path))
    except Exception as e:
        print(f"CRITICAL ERROR writing file {file_path}: {e}")
        # Final attempt: try direct write if move fails
        try:
            with open(file_path, "w", encoding=encoding) as f:
                f.write(content)
        except Exception as e2:
            print(f"FAILED direct write fallback: {e2}")

def sanitize_filename(name: str) -> str:
    """Removes invalid OS filename characters from string."""
    name = re.sub(r'[\\/*?:"<>|]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def clean_vtt_text(vtt_text: str) -> str:
    """Cleans VTT/SRT/TTML caption files by removing timestamps, tags, and metadata."""
    if not vtt_text:
        return ""
    # Strip HTML/XML tags
    text = re.sub(r'<[^>]+>', ' ', vtt_text)
    # Strip WebVTT headers / metadata
    text = re.sub(r'WEBVTT.*?\n', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'Kind:.*?\n', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'Language:.*?\n', '\n', text, flags=re.IGNORECASE)
    text = re.sub(r'STYLE[\s\S]*?\n\n', '\n\n', text, flags=re.IGNORECASE)
    # Remove timestamps (e.g., 00:00:00.000 --> 00:00:00.000 or 00:00.000 --> 00:00.000)
    text = re.sub(r'\d{1,2}:?\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{1,2}:?\d{2}:\d{2}[\.,]\d{3}.*', '', text)
    text = re.sub(r'\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{2}:\d{2}[\.,]\d{3}.*', '', text)
    # Strip positioning attributes (e.g., align:start position:0%)
    text = re.sub(r'align:\S+|position:\S+|line:\S+|size:\S+', '', text)
    # Remove duplicate adjacent lines (common in VTT rolling captions)
    lines = text.splitlines()
    clean_lines = []
    last_line = ""
    for line in lines:
        line = line.strip()
        if not line or line.isdigit():
            continue
        if line != last_line:
            clean_lines.append(line)
            last_line = line
    
    return " ".join(clean_lines).strip()


# ==========================================
# 3. LOCAL EVALUATION & ROUTING ENGINE
# ==========================================

def inspect_text_quality(text: str) -> dict:
    """Calculates word count and punctuation density locally."""
    if not text:
        return {"words": 0, "punc_ratio": 0.0, "score": 0.0}

    words = text.split()
    total_words = len(words)
    if total_words == 0:
        return {"words": 0, "punc_ratio": 0.0, "score": 0.0}

    punctuation_count = len(re.findall(r"[.,!?]", text))
    punc_ratio = punctuation_count / total_words
    score = total_words + (punc_ratio * 300)

    return {"words": total_words, "punc_ratio": punc_ratio, "score": score}


def select_best_extract_locally(native_sub: str, whisper_sub: str) -> tuple[str, str, str]:
    """Compares Native vs Whisper extracts locally."""
    native_stats = inspect_text_quality(native_sub)
    whisper_stats = inspect_text_quality(whisper_sub)

    if native_stats["words"] == 0 and whisper_stats["words"] > 0:
        return "Whisper ASR", whisper_sub, "Native captions were empty. Selected Whisper transcript."
    if whisper_stats["words"] == 0 and native_stats["words"] > 0:
        return "yt-dlp Native", native_sub, "Whisper transcript empty. Selected Native captions."

    print("\nLocal Quality Comparison:")
    print(f"   - yt-dlp Native Captions: {native_stats['words']} words | Punc Ratio: {native_stats['punc_ratio']:.2f}")
    print(f"   - Faster-Whisper ASR:    {whisper_stats['words']} words | Punc Ratio: {whisper_stats['punc_ratio']:.2f}")

    if whisper_stats["words"] > (native_stats["words"] * 1.25) and whisper_stats["punc_ratio"] >= 0.02:
        return "Whisper ASR", whisper_sub, f"Whisper is significantly more complete ({whisper_stats['words']} vs {native_stats['words']} words)."

    if native_stats["words"] > (native_stats["words"] * 1.25) and native_stats["punc_ratio"] >= 0.02:
        return "yt-dlp Native", native_sub, f"Native captions are significantly more complete ({native_stats['words']} vs {native_stats['words']} words)."

    if native_stats["score"] >= whisper_stats["score"]:
        return "yt-dlp Native", native_sub, "Native captions selected (Higher quality score/structure)."
    else:
        return "Whisper ASR", whisper_sub, "Whisper transcript selected (Higher quality score/structure)."


# ==========================================
# 4. EXTRACTION MODULES WITH PROGRESS BARS
# ==========================================

def process_web_url(url: str, item_raw_folder: Path, main_extractions_folder: Path):
    """Crawls a web page using Crawl4AI and converts it to clean markdown."""
    print(f"Web URL detected. Routing to Crawl4AI pipeline: {url}")
    
    try:
        with tqdm(total=1, desc="[Crawl4AI Web Scraping]", leave=False) as pbar:
            import asyncio
            
            async def crawl():
                config = CrawlerRunConfig(
                    cache_mode=CacheMode.BYPASS,
                    word_count_threshold=10,
                    remove_overlay_elements=True,
                )
                async with AsyncWebCrawler() as crawler:
                    result = await crawler.arun(url=url, config=config)
                    if not result.success:
                        raise ValueError(f"Crawl failed: {result.error_message}")
                    page_title = result.metadata.get("title", "Web Page")
                    return result.markdown, page_title

            content, title = asyncio.run(crawl())
            pbar.update(1)
            
        if not content:
            raise ValueError("Crawl4AI returned empty content.")

        # Save raw to item folder
        raw_out_file = item_raw_folder / "crawl4ai_raw.md"
        safe_write_file(raw_out_file, f"# Raw Web Crawl: {url}\n\n{content}")

        sanitized_title = sanitize_filename(title)
        master_out_file = main_extractions_folder / f"{sanitized_title}.md"
        safe_write_file(master_out_file, f"# {title}\n\n**Source URL:** {url}\n\n---\n\n{content}")
            
        print(f"Successfully crawled and saved: {title}")

    except Exception as e:
        print(f"ERROR: Crawl4AI failed for {url}: {e}")
        # Fallback to simple urllib request if Crawl4AI fails
        try:
            print("Falling back to simple text extraction...")
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as response:
                html = response.read().decode('utf-8', errors='ignore')
                text = re.sub(r'<[^>]*>', '', html)
                content = " ".join(text.split())
                
                master_out_file = main_extractions_folder / f"fallback_{int(time.time())}.md"
                safe_write_file(master_out_file, f"# Fallback Web Extract\n\n**Source:** {url}\n\n---\n\n{content}")
        except Exception as e2:
            print(f"CRITICAL: Fallback also failed: {e2}")


def transcribe_audio_whisper(audio_path: str) -> str:
    """Transcribes audio using Faster-Whisper with real-time ETA progress bar."""
    whisper = get_whisper()
    if not whisper:
        return "Audio transcription failed: Required libraries (torch/faster-whisper) not installed."
        
    try:
        segments, info = whisper.transcribe(audio_path, beam_size=1, vad_filter=True)
        
        total_duration = round(info.duration, 2)
        transcript_text = []
        last_timestamp = 0.0

        print(f"Audio Duration: {total_duration}s | Language: {info.language.upper()}")
        with tqdm(total=total_duration, unit="s", desc="[Audio Speech-to-Text]", leave=False) as pbar:
            for segment in segments:
                transcript_text.append(segment.text.strip())
                segment_length = segment.end - last_timestamp
                pbar.update(segment_length)
                last_timestamp = segment.end
            if last_timestamp < total_duration:
                pbar.update(total_duration - last_timestamp)
        
        result_text = " ".join(transcript_text).strip()
        
        if not result_text:
            print("WARNING: vad_filter=True returned no text. Retrying without VAD...")
            segments, info = whisper.transcribe(audio_path, beam_size=1, vad_filter=False)
            transcript_text = [segment.text.strip() for segment in segments]
            result_text = " ".join(transcript_text).strip()

        return result_text
    except Exception as e:
        print(f"ERROR: Whisper transcription failed: {e}")
        return ""


def process_youtube_url(video_url: str, item_raw_folder: Path, main_extractions_folder: Path, preferred_method: str = "auto"):
    """Fetches native captions and Whisper ASR transcripts, respecting user preference with fallback."""
    # Only process if it's actually a YouTube URL
    if "youtube.com" not in video_url.lower() and "youtu.be" not in video_url.lower():
        return process_web_url(video_url, item_raw_folder, main_extractions_folder)

    # Normalize preference method aliases
    preferred_method = preferred_method.lower().strip()
    if preferred_method in ["yt-dlp", "yt_dlp", "native", "captions", "caption"]:
        preferred_method = "captions"
    elif preferred_method in ["whisper", "asr", "whisper_asr"]:
        preferred_method = "whisper"
    elif preferred_method not in ["auto", "captions", "whisper"]:
        preferred_method = "auto"

    DOWNLOADS_DIR.mkdir(exist_ok=True)
    native_text = ""
    whisper_text = ""
    video_title = "YouTube Video"
    
    # Define priorities based on preference
    # "auto": native -> whisper (original logic)
    # "captions": native (primary), whisper (fallback)
    # "whisper": whisper (primary), native (fallback)
    
    # Step A: Fetch Native Captions via yt-dlp
    ydl_opts_subs = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        # Explicitly include common English variants
        "subtitleslangs": ["en.*", "en", "en-US", "en-GB", "en-orig", "en-ca"], 
        "quiet": True,
    }
    
    should_try_native = (preferred_method == "auto" or preferred_method == "captions")
    
    if should_try_native:
        try:
            with tqdm(total=1, desc="[Fetching Subtitle Stream]", leave=False) as pbar:
                with yt_dlp.YoutubeDL(ydl_opts_subs) as ydl:
                    info = ydl.extract_info(video_url, download=False)
                    video_title = info.get("title", "YouTube Video")
                    
                    # Combine manual subtitles and auto-generated ones
                    manual_subs = info.get("subtitles") or {}
                    auto_subs = info.get("automatic_captions") or {}
                    all_subs = {**auto_subs, **manual_subs}
                    
                    # Log available captions for debugging
                    available_keys = list(all_subs.keys())
                    if available_keys:
                        print(f"DEBUG: Available captions: {available_keys}")

                    # Priority: Manual English variants -> Auto English variants -> Any Manual -> Any Auto
                    # Explicitly check for en-orig as a high-priority variant
                    target_sub_key = (
                        next((k for k in manual_subs if k == "en-orig"), None) or
                        next((k for k in manual_subs if k.startswith("en")), None) or
                        next((k for k in auto_subs if k.startswith("en")), None) or
                        (next(iter(manual_subs.keys()), None) if manual_subs else None) or
                        (next(iter(auto_subs.keys()), None) if auto_subs else None)
                    )
                    target_sub = all_subs.get(target_sub_key) if target_sub_key else None
                    
                    if target_sub:
                        # Priority 1: json3 format for cleaner parsing
                        json3_url = next((fmt.get("url") for fmt in target_sub if fmt.get("ext") == "json3"), None)
                        if json3_url:
                            try:
                                req = urllib.request.urlopen(json3_url)
                                data = json.loads(req.read().decode("utf-8"))
                                parts = [
                                    seg.get("utf8", "")
                                    for event in data.get("events", []) if "segs" in event
                                    for seg in event["segs"]
                                ]
                                native_text = " ".join(parts).strip()
                            except Exception as json_err:
                                print(f"DEBUG: Failed parsing json3 captions: {json_err}")
                                native_text = ""

                        # Fallback: try vtt/srv1/ttml/srt or any available format if json3 missing or empty
                        if not native_text:
                            for fmt in target_sub:
                                fmt_url = fmt.get("url")
                                fmt_ext = fmt.get("ext", "unknown")
                                if not fmt_url:
                                    continue
                                try:
                                    print(f"DEBUG: Attempting caption fallback format ({fmt_ext})...")
                                    req = urllib.request.urlopen(fmt_url)
                                    raw_sub_data = req.read().decode("utf-8", errors="ignore")
                                    cleaned = clean_vtt_text(raw_sub_data)
                                    if cleaned:
                                        native_text = cleaned
                                        break
                                except Exception as fmt_err:
                                    print(f"DEBUG: Failed downloading format {fmt_ext}: {fmt_err}")

                pbar.update(1)
        except Exception as e:
            print(f"WARNING: Native caption stream skipped: {e}")

    # Step B: Download Audio Track and transcribe with Whisper
    audio_file = DOWNLOADS_DIR / f"temp_{int(time.time())}.mp3"
    
    should_try_whisper = (preferred_method == "auto" or preferred_method == "whisper" or (preferred_method == "captions" and not native_text))
    
    if should_try_whisper:
        pbar_dl = tqdm(total=100, unit="%", desc="[Downloading Audio Track]", leave=False)
        def yt_dlp_hook(d):
            if d['status'] == 'downloading':
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
                downloaded = d.get('downloaded_bytes', 0)
                percent = int((downloaded / total) * 100)
                pbar_dl.n = percent
                pbar_dl.refresh()
            elif d['status'] == 'finished':
                pbar_dl.n = 100
                pbar_dl.refresh()

        ydl_opts_audio = {
            "format": "bestaudio/best",
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
            "outtmpl": str(audio_file.with_suffix("")),
            "progress_hooks": [yt_dlp_hook],
            "quiet": True,
        }

        download_success = False
        try:
            with yt_dlp.YoutubeDL(ydl_opts_audio) as ydl:
                info = ydl.extract_info(video_url, download=True)
                if not video_title or video_title == "YouTube Video":
                    video_title = info.get("title", "YouTube Video")
            pbar_dl.close()
            whisper_text = transcribe_audio_whisper(str(audio_file))
            if audio_file.exists():
                audio_file.unlink()
            download_success = True
        except Exception as e:
            pbar_dl.close()
            print(f"WARNING: Standard MP3 download failed (FFmpeg might be missing): {e}")

        if not download_success:
            # Fallback: Download raw audio directly (FFmpeg not required)
            print("Attempting raw audio download fallback (no FFmpeg)...")
            pbar_dl_fallback = tqdm(total=100, unit="%", desc="[Downloading Audio Fallback]", leave=False)
            
            def yt_dlp_hook_fallback(d):
                if d['status'] == 'downloading':
                    total = d.get('total_bytes') or d.get('total_bytes_estimate') or 1
                    downloaded = d.get('downloaded_bytes', 0)
                    percent = int((downloaded / total) * 100)
                    pbar_dl_fallback.n = percent
                    pbar_dl_fallback.refresh()
                elif d['status'] == 'finished':
                    pbar_dl_fallback.n = 100
                    pbar_dl_fallback.refresh()

            raw_audio_file = DOWNLOADS_DIR / f"temp_raw_{int(time.time())}.%(ext)s"
            ydl_opts_raw = {
                "format": "bestaudio/best",
                "outtmpl": str(raw_audio_file),
                "progress_hooks": [yt_dlp_hook_fallback],
                "quiet": True,
            }
            try:
                with yt_dlp.YoutubeDL(ydl_opts_raw) as ydl:
                    info = ydl.extract_info(video_url, download=True)
                    if not video_title or video_title == "YouTube Video":
                        video_title = info.get("title", "YouTube Video")
                    filename = ydl.prepare_filename(info)
                pbar_dl_fallback.close()
                whisper_text = transcribe_audio_whisper(filename)
                if os.path.exists(filename):
                    os.unlink(filename)
            except Exception as e_fallback:
                pbar_dl_fallback.close()
                print(f"WARNING: Fallback Whisper pipeline also failed: {e_fallback}")

    # Step C: Local Evaluation / Winner Selection
    # If "auto", we use the original quality comparison
    if preferred_method == "auto":
        winner_name, winner_text, reason = select_best_extract_locally(native_text, whisper_text)
    elif preferred_method == "captions":
        if native_text:
            winner_name, winner_text, reason = "yt-dlp Native", native_text, "Preferred method (Captions) succeeded."
        elif whisper_text:
            winner_name, winner_text, reason = "Whisper ASR", whisper_text, "Preferred (Captions) failed, fell back to Whisper."
        else:
            winner_name, winner_text, reason = "None", "", "Both extraction methods failed."
    elif preferred_method == "whisper":
        if whisper_text:
            winner_name, winner_text, reason = "Whisper ASR", whisper_text, "Preferred method (Whisper) succeeded."
        elif native_text:
            winner_name, winner_text, reason = "yt-dlp Native", native_text, "Preferred (Whisper) failed, fell back to Captions."
        else:
            winner_name, winner_text, reason = "None", "", "Both extraction methods failed."
    else:
        # Default to "auto" logic if method is unknown or empty
        winner_name, winner_text, reason = select_best_extract_locally(native_text, whisper_text)
        reason = f"Invalid preference method '{preferred_method}', defaulted to Auto selection."

    print(f"[Local Decision]: Chosen Winner -> {winner_name} ({reason})")
    
    # Save outputs (identical to original)
    is_native_selected = "[SELECTED]" if winner_name == "yt-dlp Native" else "[NOT SELECTED]"
    is_whisper_selected = "[SELECTED]" if winner_name == "Whisper ASR" else "[NOT SELECTED]"
    
    native_out_file = item_raw_folder / f"yt_dlp_native_{is_native_selected.lower().strip('[]')}.md"
    safe_write_file(native_out_file, f"# {video_title} (yt-dlp Native Captions) {is_native_selected}\n\n{native_text or 'No native captions available.'}")
    
    whisper_out_file = item_raw_folder / f"whisper_asr_{is_whisper_selected.lower().strip('[]')}.md"
    safe_write_file(whisper_out_file, f"# {video_title} (Faster-Whisper ASR) {is_whisper_selected}\n\n{whisper_text or 'No Whisper transcript available.'}")
    
    meta_file = item_raw_folder / "extraction_meta.json"
    safe_write_file(meta_file, json.dumps({
        "title": video_title,
        "url": video_url,
        "selected_service": winner_name,
        "reason": reason,
        "timestamp": time.time()
    }, indent=2), encoding="utf-8")

    sanitized_title = sanitize_filename(video_title)
    master_out_file = main_extractions_folder / f"{sanitized_title}.md"
    safe_write_file(master_out_file, 
        f"# {video_title}\n\n"
        f"**Source URL:** {video_url}\n\n"
        f"--- \n\n"
        f"**Selected Service:** `{winner_name}`\n"
        f"**Selection Reason:** {reason}\n\n"
        f"{winner_text or 'No content extracted.'}"
    )


def process_local_file(file_path: str, item_raw_folder: Path, main_extractions_folder: Path, ocr_preference: str = "adaptive"):
    """Processes local documents/media via Docling or Whisper, routing cleanly."""
    path = Path(file_path).resolve()
    if not path.exists():
        print(f"ERROR: Local file does not exist: {path}")
        return

    # Audio & Video Media Extensions to Route to Faster-Whisper ASR
    media_extensions = {".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".mp4", ".mov", ".mkv", ".avi", ".webm"}
    is_media_file = path.suffix.lower() in media_extensions

    content = ""

    if is_media_file:
        # Transcribe local media with Whisper
        print(f"Media File Detected ({path.suffix.upper()}). Routing to Faster-Whisper ASR pipeline...")
        content = transcribe_audio_whisper(str(path))
        
        # Save raw to item-specific folder
        raw_out_file = item_raw_folder / "whisper_asr_raw.md"
        safe_write_file(raw_out_file, f"# Raw Whisper ASR: {path.name}\n\n{content}")
            
        # Save clean winning note
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        safe_write_file(master_out_file, 
            f"# Transcript: {path.name}\n\n"
            f"**Source File:** `{path.name}`\n"
            f"**Engine:** `Faster-Whisper ASR`\n\n"
            f"---\n\n"
            f"{content}"
        )
            
    elif path.suffix.lower() == ".pdf":
        # Safe Handling for Large PDFs
        reader = PdfReader(str(path))
        total_pages = len(reader.pages)

        if total_pages > 100:
            print(f"Large PDF Detected ({total_pages} pages). Processing in 50-page chunks in parallel with process timeout safety...")
            chunk_size = 50
            DOWNLOADS_DIR.mkdir(exist_ok=True)
            
            # Create all temp chunk files first
            chunk_files = []
            for start in range(0, total_pages, chunk_size):
                end = min(start + chunk_size, total_pages)
                writer = PdfWriter()
                for i in range(start, end):
                    writer.add_page(reader.pages[i])
                temp_chunk_path = DOWNLOADS_DIR / f"temp_chunk_{start}_{end}.pdf"
                with open(temp_chunk_path, "wb") as f:
                    writer.write(f)
                chunk_files.append((start, end, temp_chunk_path))
                
            # Run parallel execution using a shared ProcessPoolExecutor outside the loop
            results_dict = {}
            max_workers = min(4, len(chunk_files)) # process chunks in parallel using up to 4 worker processes
            
            with tqdm(total=total_pages, unit="page", desc="[Docling PDF Parsing]", leave=False) as pbar:
                with concurrent.futures.ProcessPoolExecutor(max_workers=max_workers) as executor:
                    # Submit all chunks to pool
                    future_to_chunk = {
                        executor.submit(_docling_worker, str(p), ocr_preference): (start, end, p)
                        for start, end, p in chunk_files
                    }
                    
                    # Gather results as they complete
                    for future in concurrent.futures.as_completed(future_to_chunk):
                        start, end, p = future_to_chunk[future]
                        chunk_md = None
                        try:
                            # 90 seconds timeout per chunk
                            chunk_md = future.result(timeout=90)
                        except concurrent.futures.TimeoutError:
                            print(f"\nWARNING: Chunk pages {start+1}-{end} timed out. Falling back to raw text extraction...")
                        except Exception as err:
                            print(f"\nWARNING: Chunk pages {start+1}-{end} failed layout conversion ({err}). Falling back to raw text extraction...")
                        
                        # Fallback if docling failed or timed out
                        if chunk_md is None:
                            fallback_text = []
                            for i in range(start, end):
                                page_text = reader.pages[i].extract_text() or ""
                                fallback_text.append(f"### Page {i+1}\n\n{page_text}")
                            chunk_md = "\n\n".join(fallback_text)
                            
                        results_dict[start] = chunk_md
                        pbar.update(end - start)
                        
                        # Cleanup temp file
                        if p.exists():
                            p.unlink()
            
            # Sort by start page to maintain order
            full_markdown = [results_dict[start] for start in sorted(results_dict.keys())]
            content = "\n\n---\n\n".join(full_markdown)
            gc.collect()
        else:
            with tqdm(total=total_pages, unit="page", desc="[Docling PDF Parsing]", leave=False) as pbar:
                content = _docling_worker(str(path), ocr_preference=ocr_preference)
                pbar.update(total_pages)
        # Save raw to raw_service_files folder
        raw_out_file = item_raw_folder / "docling_raw.md"
        safe_write_file(raw_out_file, f"# Raw Docling Extraction: {path.name}\n\n{content}")
        
        # Save clean note to main extractions directory
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        safe_write_file(master_out_file, f"# Note: {path.stem}\n\n**Source File:** `{path.name}`\n\n{content}")

            
    else:
        # standard office files layout extraction via Docling
        with tqdm(total=1, desc=f"[Docling Parsing {path.suffix.upper()}]", leave=False) as pbar:
            enable_ocr = (ocr_preference == "on")
            docling = get_docling(enable_ocr=enable_ocr)
            if not docling:
                content = "Office conversion failed: 'docling' not installed."
            else:
                result = docling.convert(str(path))
                content = result.document.export_to_markdown()
            pbar.update(1)
            
        # Save raw to raw_service_files folder
        raw_out_file = item_raw_folder / "docling_raw.md"
        safe_write_file(raw_out_file, f"# Raw Docling Extraction: {path.name}\n\n{content}")
        
        # Save clean note to main extractions directory
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        safe_write_file(master_out_file, f"# Note: {path.stem}\n\n**Source File:** `{path.name}`\n\n{content}")



def open_file_picker() -> list[str]:
    """Opens system file explorer modal."""
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)

    files = filedialog.askopenfilenames(
        title="Cerebro - Select Local File(s)",
        filetypes=[
            ("All Supported Files", "*.pdf *.docx *.pptx *.xlsx *.mp3 *.wav *.m4a *.mp4 *.mov *.png *.jpg *.jpeg *.html"),
            ("PDF Documents", "*.pdf"),
            ("Audio / Speech", "*.mp3 *.wav *.m4a *.flac"),
            ("Video Files", "*.mp4 *.mov *.mkv *.avi"),
            ("Office Documents", "*.docx *.pptx *.xlsx"),
            ("Images / OCR", "*.png *.jpg *.jpeg *.webp"),
            ("All Files", "*.*")
        ]
    )
    return list(files)


# ==========================================
# 5. MAIN PIPELINE ROUTER
# ==========================================

def run_cerebro():
    global logger
    logger = setup_logging()
    
    # Parse Command Line Arguments first (For automation / Cerebro App button integration)
    parser = argparse.ArgumentParser(description="Cerebro Master Extractor Pipeline")
    parser.add_argument("--vault", type=str, help="Outputs clean final notes directly to this folder")
    parser.add_argument("--files", type=str, nargs="+", help="Automated batch files processing list")
    parser.add_argument("--urls", type=str, nargs="+", help="Automated batch URLs processing list")
    parser.add_argument("--yt_method", type=str, default="auto", help="YouTube extraction method: 'auto', 'captions', or 'whisper'")
    parser.add_argument("--ocr", type=str, default="adaptive", choices=["on", "off", "adaptive"], help="OCR mode: 'on', 'off', or 'adaptive' (default)")
    
    args = parser.parse_args()

    # Determine Output Directory paths
    main_extractions_folder = OUTPUT_DIR / "main_extractions"
    raw_service_folder = OUTPUT_DIR / "raw_service_files"

    if args.vault:
        # Override clean notes destination directly to Cerebro note vault
        main_extractions_folder = Path(args.vault).resolve()
        logger.info(f"Note vault specified! Redirecting final clean notes to: {main_extractions_folder}")

    # Ensure directories are created
    main_extractions_folder.mkdir(parents=True, exist_ok=True)
    raw_service_folder.mkdir(parents=True, exist_ok=True)

    sources = [] # Will be list of (path, ocr_mode)
    automated_mode = False
    default_ocr_pref = args.ocr

    # CLI / Automated Mode Trigger
    if args.files or args.urls:
        automated_mode = True
        
        # If OCR mode is passed via CLI, we need to respect it
        # Note: When called via Tauri/Rust, the OCR mode is passed via the --yt_method argument
        # because the Rust backend reuses the yt_method slot for OCR mode when ingest_type is 'file'.
        
        # Let's check args.yt_method to see if it contains an OCR override
        ocr_mode_from_args = args.yt_method if args.yt_method in ["A", "O", "N"] else args.ocr
        
        all_sources = []
        if args.files:
            all_sources.extend(args.files)
        if args.urls:
            all_sources.extend(args.urls)
        
        # Check for OCR override in filename
        for s in all_sources:
            if "|" in s:
                path, mode = s.split("|", 1)
                sources.append((path, mode))
            else:
                sources.append((s, ocr_mode_from_args))

        logger.info(f"Batch mode activated via CLI! Loaded {len(sources)} sources to extract.")
    else:
        # Standard Interactive Terminal Menu Mode
        logger.info("\n" + "="*50)
        logger.info("CEREBRO UNIFIED INGESTION SYSTEM")
        logger.info("="*50)
        logger.info("OCR Mode Settings: [A] Adaptive (Default) | [O] Force OCR ON | [N] Force OCR OFF")
        ocr_mode = input("Select OCR Mode [A, O, or N]: ").strip().upper()
        ocr_pref = "adaptive" if ocr_mode == "A" else "on" if ocr_mode == "O" else "off"
        
        logger.info("\nSources:")
        logger.info("1. Select Local File(s) (Opens File Explorer)")
        logger.info("2. Process YouTube URL(s) / Web Link(s)")

        choice = input("\nSelect Option [1 or 2]: ").strip()
        print(choice)

        if choice == "1":
            logger.info("\nOpening System File Explorer...")
            files = open_file_picker()
            if not files:
                logger.warning("WARNING: No file selected. Exiting.")
                return
            for f in files:
                sources.append((f, ocr_pref))
        elif choice == "2":
            raw_urls = input("\nEnter YouTube URL(s) (comma-separated for multiple): ").strip()
            print(raw_urls)
            if raw_urls:
                for u in raw_urls.split(","):
                    if u.strip():
                        sources.append((u.strip(), ocr_pref))
            else:
                logger.warning("WARNING: No URL entered. Exiting.")
                return
        else:
            logger.error(f"ERROR: Invalid selection '{choice}'. Exiting.")
            return

    total_batch_start = time.time()
    total_items = len(sources)

    logger.info(f"\nProcessing {total_items} item(s)...")

    # Overall Batch Progress Bar
    with tqdm(total=total_items, desc="[Batch Progress]", unit="item") as batch_pbar:
        for idx, (source, ocr_mode) in enumerate(sources, start=1):
            item_start_time = time.time()
            
            # Isolated item-specific folder inside raw service files directory
            item_raw_folder = raw_service_folder / f"item_{idx}_{int(time.time())}"
            item_raw_folder.mkdir(parents=True, exist_ok=True)

            logger.info(f"\n" + "-"*50)
            logger.info(f"Processing Item [{idx}/{total_items}]: {source}")
            logger.info(f"OCR Mode: {ocr_mode}")
            logger.info("-" * 50)

            # Route Logic
            if source.startswith("http://") or source.startswith("https://"):
                process_youtube_url(source, item_raw_folder, main_extractions_folder, preferred_method=args.yt_method if args.yt_method else "auto")
            else:
                process_local_file(source, item_raw_folder, main_extractions_folder, ocr_preference=ocr_mode)

            item_elapsed = time.time() - item_start_time
            logger.info(f"\nItem #{idx} Finished in {item_elapsed:.2f}s")
            logger.info(f"Main Clean Extraction: {main_extractions_folder.absolute()}")
            logger.info(f"Raw Service Files: {item_raw_folder.absolute()}")

            batch_pbar.update(1)

    total_elapsed = time.time() - total_batch_start
    logger.info("\n" + "="*50)
    logger.info(f"ALL {total_items} ITEM(S) COMPLETED SUCCESSFULLY!")
    logger.info(f"Total Execution Time: {total_elapsed:.2f}s")
    logger.info(f"Clean Notes Folder: {main_extractions_folder.absolute()}")
    logger.info(f"Raw Services Folder: {raw_service_folder.absolute()}")
    logger.info("="*50)


if __name__ == "__main__":
    import multiprocessing
    # Required for macOS and Windows subprocess stability within PyPdfium chunk pools
    multiprocessing.set_start_method("spawn", force=True)
    multiprocessing.freeze_support()
    run_cerebro()
