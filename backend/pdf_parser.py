import sys
import argparse
from pypdf import PdfReader

def extract_pdf_text(filepath):
    try:
        reader = PdfReader(filepath)
        text = []
        for i, page in enumerate(reader.pages):
            page_text = page.extract_text()
            if page_text:
                text.append(page_text)
        return "\n".join(text)
    except Exception as e:
        print(f"Error reading PDF: {e}", file=sys.stderr)
        return ""

def main():
    # Force UTF-8 stdout to prevent Unicode mapping crashes on Windows terminals
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        
    parser = argparse.ArgumentParser(description="Extract raw text from PDF protocols")
    parser.add_argument("--file", type=str, required=True, help="Path to PDF file")
    args = parser.parse_args()

    text = extract_pdf_text(args.file)
    if not text:
        sys.exit(1)
        
    print(text)

if __name__ == "__main__":
    main()
