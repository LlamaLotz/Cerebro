import re

# --- Functions being tested (copied from master_extractor.py) ---
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

# --- Tests ---
print("Testing sanitize_filename...")
test_names = ["Invalid/Filename:*", "Normal File Name", "  Spaces  Test  "]
for name in test_names:
    sanitized = sanitize_filename(name)
    print(f"  Input: '{name}' -> Output: '{sanitized}'")

print("\nTesting clean_vtt_text...")
raw_vtt = """WEBVTT
Kind: captions

00:00:01.000 --> 00:00:03.000
Hello world.

00:00:03.000 --> 00:00:05.000
Hello world.
This is a test.
"""
cleaned = clean_vtt_text(raw_vtt)
print(f"  Raw VTT:\n{raw_vtt.strip()}\n")
print(f"  Cleaned Output: '{cleaned}'")
