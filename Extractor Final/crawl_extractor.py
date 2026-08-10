import asyncio
from pathlib import Path
from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode

async def extract_webpage_to_markdown(url: str, output_dir: str = "cerebro_output"):
    """
    Renders a live dynamic webpage using Crawl4AI and extracts clean Markdown.
    """
    Path(output_dir).mkdir(exist_ok=True)
    print(f"\n🌐 Crawling Webpage: {url}")

    # Configure crawler to bypass caches and strip unnecessary page elements
    config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,  # Forces a fresh page fetch
        word_count_threshold=10,       # Filters out tiny text blocks / UI clutter
        remove_overlay_elements=True,  # Removes cookie banners, popups, and overlays
    )

    async with AsyncWebCrawler() as crawler:
        # Run asynchronous browser extraction
        result = await crawler.arun(url=url, config=config)

        if not result.success:
            print(f"❌ Failed to crawl webpage. Error: {result.error_message}")
            return None

        video_or_page_title = result.metadata.get("title", "webpage_content")
        markdown_text = result.markdown

        # Save extracted Markdown to Cerebro output directory
        out_file = Path(output_dir) / "extracted_web_content.md"
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(f"# {video_or_page_title}\n\nURL: {url}\n\n---\n\n{markdown_text}")

        print("\n" + "="*50)
        print("🎉 SUCCESS! Webpage successfully extracted.")
        print(f"📁 Saved to: {out_file.absolute()}")
        print("="*50)
        print("\n🔍 Preview (First 400 chars):\n")
        print(markdown_text[:400] + "...")

        return markdown_text

if __name__ == "__main__":
    target_url = input("Enter a website URL: ").strip()
    if target_url:
        # Crawl4AI runs asynchronously
        asyncio.run(extract_webpage_to_markdown(target_url))