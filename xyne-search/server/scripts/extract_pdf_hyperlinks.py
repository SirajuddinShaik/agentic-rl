#!/usr/bin/env python3

import argparse
import json
import sys
from collections import OrderedDict
from pathlib import Path

try:
    import fitz
except ImportError as exc:
    raise SystemExit(
        "PyMuPDF is required. Install it with: pip install pymupdf"
    ) from exc


def normalize_text(value: str) -> str:
    return " ".join(value.split())


def merge_segment_text(existing: str, new_text: str) -> str:
    if not existing:
        return new_text
    if existing.endswith("-"):
        return existing + new_text
    return f"{existing} {new_text}"


def extract_links_combined(pdf_path: Path) -> list[dict[str, object]]:
    grouped_links: "OrderedDict[tuple[int, str], dict[str, object]]" = OrderedDict()

    with fitz.open(pdf_path) as document:
        for page_index in range(len(document)):
            page = document[page_index]
            current_page = page_index + 1

            for link in page.get_links():
                url = link.get("uri")
                rect = link.get("from")
                if not url or rect is None:
                    continue

                box_text = normalize_text(page.get_textbox(rect).strip())
                key = (current_page, url)

                if key not in grouped_links:
                    grouped_links[key] = {
                        "page": current_page,
                        "url": url,
                        "text": box_text or None,
                        "rects": [list(rect)],
                    }
                    continue

                entry = grouped_links[key]
                if box_text:
                    existing_text = entry["text"] or ""
                    entry["text"] = merge_segment_text(existing_text, box_text)
                entry["rects"].append(list(rect))

    return list(grouped_links.values())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract hyperlinks and anchor text from a PDF using PyMuPDF."
    )
    parser.add_argument("pdf_path", help="Path to the PDF file")
    parser.add_argument(
        "--indent",
        type=int,
        default=2,
        help="JSON indentation level. Use 0 for compact output.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pdf_path = Path(args.pdf_path).expanduser().resolve()

    if not pdf_path.is_file():
        print(f"PDF file not found: {pdf_path}", file=sys.stderr)
        return 1

    links = extract_links_combined(pdf_path)
    payload = {
        "pdfPath": str(pdf_path),
        "totalLinks": len(links),
        "links": links,
    }

    indent = None if args.indent <= 0 else args.indent
    print(json.dumps(payload, indent=indent, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())