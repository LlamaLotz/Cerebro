import os
import sys
import re
import json
import time
import gc
import urllib.request
import concurrent.futures
import argparse
from pathlib import Path
from difflib import SequenceMatcher
import tkinter as tk
from tkinter import filedialog

# Suppress non-critical warnings
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import torch
import yt_dlp
from tqdm import tqdm
from pypdf import PdfReader, PdfWriter
from faster_whisper import WhisperModel

# Docling Imports
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.base_models import InputFormat
from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend

# Crawl4AI Import
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode


# ==========================================
# 1. SETUP BASE PATHS & ENGINE LOADERS
# ==========================================

SCRIPT_DIR = Path(__file__).parent.resolve()
OUTPUT_DIR = SCRIPT_DIR / "cerebro_output"
DOWNLOADS_DIR = SCRIPT_DIR / "downloads"

WHISPER_MODEL = None
DOCLING_CONVERTER = None

def get_whisper():
    """Lazy loader for Faster-Whisper."""
    global WHISPER_MODEL
    if WHISPER_MODEL is None:
        print("Initializing Faster-Whisper local model...")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if torch.cuda.is_available() else "int8"
        WHISPER_MODEL = WhisperModel("small", device=device, compute_type=compute_type)
    return WHISPER_MODEL

def get_docling():
    """Lazy loader for Optimized Docling Engine."""
    global DOCLING_CONVERTER
    if DOCLING_CONVERTER is None:
        pipeline_options = PdfPipelineOptions()
        pipeline_options.generate_picture_images = False
        pipeline_options.generate_table_images = False
        pipeline_options.do_ocr = False

        DOCLING_CONVERTER = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(
                    pipeline_options=pipeline_options,
                    backend=PyPdfiumDocumentBackend
                )
            }
        )
    return DOCLING_CONVERTER


# Worker function for process pool execution
def _docling_worker(pdf_path: str) -> str:
    docling = get_docling()
    res = docling.convert(pdf_path)
    return res.document.export_to_markdown()


# ==========================================
# 2. FILE UTILITIES & SANITIZERS
# ==========================================

def sanitize_filename(name: str) -> str:
    """Removes invalid OS filename characters from string."""
    name = re.sub(r'[\\/*?:"<>|]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


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
        with open(raw_out_file, "w", encoding="utf-8") as f:
            f.write(f"# Raw Web Crawl: {url}\n\n{content}")

        sanitized_title = sanitize_filename(title)
        master_out_file = main_extractions_folder / f"{sanitized_title}.md"
        with open(master_out_file, "w", encoding="utf-8") as f:
            f.write(f"# {title}\n\n**Source URL:** {url}\n\n---\n\n{content}")
            
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
                with open(master_out_file, "w", encoding="utf-8") as f:
                    f.write(f"# Fallback Web Extract\n\n**Source:** {url}\n\n---\n\n{content}")
        except Exception as e2:
            print(f"CRITICAL: Fallback also failed: {e2}")


def transcribe_audio_whisper(audio_path: str) -> str:
    """Transcribes audio using Faster-Whisper with real-time ETA progress bar."""
    whisper = get_whisper()
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

    return " ".join(transcript_text)


def process_youtube_url(video_url: str, item_raw_folder: Path, main_extractions_folder: Path, preferred_method: str = "auto"):
    """Fetches native captions and Whisper ASR transcripts, respecting user preference with fallback."""
    # Only process if it's actually a YouTube URL
    if "youtube.com" not in video_url.lower() and "youtu.be" not in video_url.lower():
        return process_web_url(video_url, item_raw_folder, main_extractions_folder)

    DOWNLOADS_DIR.mkdir(exist_ok=True)
    native_text = ""
    whisper_text = ""
    video_title = "YouTube Video"
    
    # Define priorities based on preference
    # "auto": native -> whisper (original logic)
    # "captions": native (primary), whisper (fallback)
    # "whisper": whisper (primary), native (fallback)
    
    # Step A: Fetch Native Captions via yt-dlp
    t_start_sub = time.time()
    ydl_opts_subs = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-US", "en-GB", "en-orig", "en.*"],
        "quiet": True,
    }

    should_try_native = (preferred_method == "auto" or preferred_method == "captions")
    
    if should_try_native:
        try:
            with tqdm(total=1, desc="[Fetching Subtitle Stream]", leave=False) as pbar:
                with yt_dlp.YoutubeDL(ydl_opts_subs) as ydl:
                    info = ydl.extract_info(video_url, download=False)
                    video_title = info.get("title", "YouTube Video")
                    all_subs = {**(info.get("automatic_captions") or {}), **(info.get("subtitles") or {})}
                    target_sub = next((all_subs[k] for k in all_subs if k.startswith("en")), None)

                    if target_sub:
                        json3_url = next((fmt.get("url") for fmt in target_sub if fmt.get("ext") == "json3"), None)
                        if json3_url:
                            req = urllib.request.urlopen(json3_url)
                            data = json.loads(req.read().decode("utf-8"))
                            parts = [
                                seg.get("utf8", "")
                                for event in data.get("events", []) if "segs" in event
                                for seg in event["segs"]
                            ]
                            native_text = " ".join(parts).strip()
                pbar.update(1)
        except Exception as e:
            print(f"WARNING: Native caption stream skipped: {e}")

    # Step B: Download Audio Track and transcribe with Whisper
    t_start_audio = time.time()
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

        try:
            with yt_dlp.YoutubeDL(ydl_opts_audio) as ydl:
                info = ydl.extract_info(video_url, download=True)
                if not video_title or video_title == "YouTube Video":
                    video_title = info.get("title", "YouTube Video")
            pbar_dl.close()
            whisper_text = transcribe_audio_whisper(str(audio_file))
            if audio_file.exists():
                audio_file.unlink()
        except Exception as e:
            pbar_dl.close()
            print(f"WARNING: Whisper pipeline skipped: {e}")

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
        winner_name, winner_text, reason = "Unknown", "", "Invalid preference method."

    print(f"[Local Decision]: Chosen Winner -> {winner_name} ({reason})")
    
    # Save outputs (identical to original)
    is_native_selected = "[SELECTED]" if winner_name == "yt-dlp Native" else "[NOT SELECTED]"
    is_whisper_selected = "[SELECTED]" if winner_name == "Whisper ASR" else "[NOT SELECTED]"
    
    native_out_file = item_raw_folder / f"yt_dlp_native_{is_native_selected.lower().strip('[]')}.md"
    with open(native_out_file, "w", encoding="utf-8") as f:
        f.write(f"# {video_title} (yt-dlp Native Captions) {is_native_selected}\n\n{native_text or 'No native captions available.'}")

    whisper_out_file = item_raw_folder / f"whisper_asr_{is_whisper_selected.lower().strip('[]')}.md"
    with open(whisper_out_file, "w", encoding="utf-8") as f:
        f.write(f"# {video_title} (Faster-Whisper ASR) {is_whisper_selected}\n\n{whisper_text or 'No Whisper transcript available.'}")

    meta_file = item_raw_folder / "extraction_meta.json"
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump({
            "title": video_title,
            "url": video_url,
            "selected_service": winner_name,
            "reason": reason,
            "timestamp": time.time()
        }, f, indent=2)

    sanitized_title = sanitize_filename(video_title)
    master_out_file = main_extractions_folder / f"{sanitized_title}.md"
    with open(master_out_file, "w", encoding="utf-8") as f:
        f.write(
            f"# {video_title}\n\n"
            f"**Source URL:** {video_url}\n\n"
            f"**Selected Service:** `{winner_name}`\n"
            f"**Selection Reason:** {reason}\n\n"
            f"---\n\n"
            f"{winner_text}"
        )


def process_local_file(file_path: str, item_raw_folder: Path, main_extractions_folder: Path):
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
        with open(raw_out_file, "w", encoding="utf-8") as f:
            f.write(f"# Raw Whisper ASR: {path.name}\n\n{content}")
            
        # Save clean winning note
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        with open(master_out_file, "w", encoding="utf-8") as f:
            f.write(
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

        if total_pages > 25:
            print(f"Large PDF Detected ({total_pages} pages). Processing in 25-page chunks with process timeout safety...")
            full_markdown = []
            chunk_size = 25

            with tqdm(total=total_pages, unit="page", desc="[Docling PDF Parsing]", leave=False) as pbar:
                for start in range(0, total_pages, chunk_size):
                    end = min(start + chunk_size, total_pages)

                    writer = PdfWriter()
                    for i in range(start, end):
                        writer.add_page(reader.pages[i])

                    temp_chunk_path = DOWNLOADS_DIR / f"temp_chunk_{start}_{end}.pdf"
                    DOWNLOADS_DIR.mkdir(exist_ok=True)
                    
                    with open(temp_chunk_path, "wb") as f:
                        writer.write(f)

                    # Execute Docling inside an isolated process pool with a 60-second timeout
                    chunk_md = None
                    with concurrent.futures.ProcessPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(_docling_worker, str(temp_chunk_path))
                        try:
                            chunk_md = future.result(timeout=60)
                        except concurrent.futures.TimeoutError:
                            print(f"\nWARNING: Chunk pages {start+1}-{end} timed out (Docling freeze). Falling back to raw text extraction...")
                        except Exception as err:
                            print(f"\nWARNING: Chunk pages {start+1}-{end} failed layout conversion ({err}). Falling back to raw text extraction...")

                    if chunk_md is None:
                        fallback_text = []
                        for i in range(start, end):
                            page_text = reader.pages[i].extract_text() or ""
                            fallback_text.append(f"### Page {i+1}\n\n{page_text}")
                        chunk_md = "\n\n".join(fallback_text)

                    full_markdown.append(chunk_md)

                    if temp_chunk_path.exists():
                        temp_chunk_path.unlink()
                    gc.collect()

                    pbar.update(end - start)

            content = "\n\n---\n\n".join(full_markdown)
        else:
            with tqdm(total=total_pages, unit="page", desc="[Docling PDF Parsing]", leave=False) as pbar:
                docling = get_docling()
                result = docling.convert(str(path))
                content = result.document.export_to_markdown()
                pbar.update(total_pages)
                
        # Save raw to raw_service_files folder
        raw_out_file = item_raw_folder / "docling_raw.md"
        with open(raw_out_file, "w", encoding="utf-8") as f:
            f.write(f"# Raw Docling Extraction: {path.name}\n\n{content}")
            
        # Save clean note to main extractions directory
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        with open(master_out_file, "w", encoding="utf-8") as f:
            f.write(f"# Note: {path.stem}\n\n**Source File:** `{path.name}`\n\n{content}")
            
    else:
        # standard office files layout extraction via Docling
        with tqdm(total=1, desc=f"[Docling Parsing {path.suffix.upper()}]", leave=False) as pbar:
            docling = get_docling()
            result = docling.convert(str(path))
            content = result.document.export_to_markdown()
            pbar.update(1)
            
        # Save raw to raw_service_files folder
        raw_out_file = item_raw_folder / "docling_raw.md"
        with open(raw_out_file, "w", encoding="utf-8") as f:
            f.write(f"# Raw Docling Extraction: {path.name}\n\n{content}")
            
        # Save clean note to main extractions directory
        sanitized_name = sanitize_filename(path.stem)
        master_out_file = main_extractions_folder / f"{sanitized_name}.md"
        with open(master_out_file, "w", encoding="utf-8") as f:
            f.write(f"# Note: {path.stem}\n\n**Source File:** `{path.name}`\n\n{content}")


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
    # Parse Command Line Arguments first (For automation / Cerebro App button integration)
    parser = argparse.ArgumentParser(description="Cerebro Master Extractor Pipeline")
    parser.add_argument("--vault", type=str, help="Outputs clean final notes directly to this folder")
    parser.add_argument("--files", type=str, nargs="+", help="Automated batch files processing list")
    parser.add_argument("--urls", type=str, nargs="+", help="Automated batch URLs processing list")
    parser.add_argument("--yt_method", type=str, default="auto", help="YouTube extraction method: 'auto', 'captions', or 'whisper'")
    
    args = parser.parse_args()

    # Determine Output Directory paths
    main_extractions_folder = OUTPUT_DIR / "main_extractions"
    raw_service_folder = OUTPUT_DIR / "raw_service_files"

    if args.vault:
        # Override clean notes destination directly to Cerebro note vault
        main_extractions_folder = Path(args.vault).resolve()
        print(f"Note vault specified! Redirecting final clean notes to: {main_extractions_folder}")

    # Ensure directories are created
    main_extractions_folder.mkdir(parents=True, exist_ok=True)
    raw_service_folder.mkdir(parents=True, exist_ok=True)

    sources = []
    automated_mode = False

    # CLI / Automated Mode Trigger
    if args.files or args.urls:
        automated_mode = True
        if args.files:
            sources.extend(args.files)
        if args.urls:
            sources.extend(args.urls)
        print(f"Batch mode activated via CLI! Loaded {len(sources)} sources to extract.")
    else:
        # Standard Interactive Terminal Menu Mode
        print("\n" + "="*50)
        print("CEREBRO UNIFIED INGESTION SYSTEM")
        print("="*50)
        print("1. Select Local File(s) (Opens File Explorer)")
        print("2. Process YouTube URL(s) / Web Link(s)")

        choice = input("\nSelect Option [1 or 2]: ").strip()

        if choice == "1":
            print("\nOpening System File Explorer...")
            sources = open_file_picker()
            if not sources:
                print("WARNING: No file selected. Exiting.")
                return
        elif choice == "2":
            raw_urls = input("\nEnter YouTube URL(s) (comma-separated for multiple): ").strip()
            if raw_urls:
                sources = [s.strip() for s in raw_urls.split(",") if s.strip()]
            else:
                print("WARNING: No URL entered. Exiting.")
                return
        else:
            print("ERROR: Invalid selection. Exiting.")
            return

    total_batch_start = time.time()
    total_items = len(sources)

    print(f"\nProcessing {total_items} item(s)...")

    # Overall Batch Progress Bar
    with tqdm(total=total_items, desc="[Batch Progress]", unit="item") as batch_pbar:
        for idx, source in enumerate(sources, start=1):
            item_start_time = time.time()
            
            # Isolated item-specific folder inside raw service files directory
            item_raw_folder = raw_service_folder / f"item_{idx}_{int(time.time())}"
            item_raw_folder.mkdir(parents=True, exist_ok=True)

            print(f"\n" + "-"*50)
            print(f"Processing Item [{idx}/{total_items}]: {source}")
            print("-" * 50)

            # Route Logic
            if source.startswith("http://") or source.startswith("https://"):
                process_youtube_url(source, item_raw_folder, main_extractions_folder, preferred_method=args.yt_method if args.yt_method else "auto")
            else:
                process_local_file(source, item_raw_folder, main_extractions_folder)

            item_elapsed = time.time() - item_start_time
            print(f"\nItem #{idx} Finished in {item_elapsed:.2f}s")
            print(f"Main Clean Extraction: {main_extractions_folder.absolute()}")
            print(f"Raw Service Files: {item_raw_folder.absolute()}")

            batch_pbar.update(1)

    total_elapsed = time.time() - total_batch_start
    print("\n" + "="*50)
    print(f"ALL {total_items} ITEM(S) COMPLETED SUCCESSFULLY!")
    print(f"Total Execution Time: {total_elapsed:.2f}s")
    print(f"Clean Notes Folder: {main_extractions_folder.absolute()}")
    print(f"Raw Services Folder: {raw_service_folder.absolute()}")
    print("="*50)


if __name__ == "__main__":
    import multiprocessing
    # Required for macOS and Windows subprocess stability within PyPdfium chunk pools
    multiprocessing.set_start_method("spawn", force=True)
    multiprocessing.freeze_support()
    run_cerebro()
