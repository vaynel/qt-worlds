#!/usr/bin/env python3
"""Build data/bible-krv.json from the downloaded getBible export of 개역한글 (KorRV).

The raw file is treated as untrusted data: it is only parsed as JSON, every
field is type-checked, and text is normalised to plain strings. Nothing from it
is executed. Run with:  python3 -I data/scripts/build_bible.py
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "getbible-korean.json"
OUT = ROOT / "bible-krv.json"
SOURCE_URL = "https://api.getbible.net/v2/korean.json"

# Standard Korean abbreviations, in canonical (Protestant) order.
ABBR = (
    "창 출 레 민 신 수 삿 룻 삼상 삼하 왕상 왕하 대상 대하 스 느 에 욥 시 잠 전 아 사 렘 애 겔 단 "
    "호 욜 암 옵 욘 미 나 합 습 학 슥 말 "
    "마 막 눅 요 행 롬 고전 고후 갈 엡 빌 골 살전 살후 딤전 딤후 딛 몬 히 약 벧전 벧후 요일 요이 요삼 유 계"
).split()
assert len(ABBR) == 66

# Markers the source uses for verses that are omitted or merged into a neighbour
# ("(앞절과 동일)" = same text as the previous verse).
PLACEHOLDERS = {"(없음)", "상동", "(앞절과 동일)"}
CONTROL = re.compile(r"[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e\ufeff]")


def clean(text: str) -> str:
    text = CONTROL.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    raw_bytes = RAW.read_bytes()
    data = json.loads(raw_bytes.decode("utf-8"))
    books_in = data.get("books")
    if not isinstance(books_in, list) or len(books_in) != 66:
        fail(f"expected 66 books, got {len(books_in) if isinstance(books_in, list) else 'none'}")

    books, verses = [], []
    placeholder_count = 0
    for index, book in enumerate(books_in, start=1):
        name = book.get("name")
        if not isinstance(name, str) or book.get("nr") != index:
            fail(f"bad book entry #{index}")
        name = clean(name)
        if name == "예레미야 애가":
            name = "예레미야애가"  # usual spelling in 개역한글
        books.append({"book": index, "name": name, "abbr": ABBR[index - 1], "testament": "OT" if index <= 39 else "NT"})
        for chapter in book.get("chapters", []):
            c = chapter.get("chapter")
            if not isinstance(c, int) or c < 1:
                fail(f"bad chapter in {name}")
            for verse in chapter.get("verses", []):
                v, t = verse.get("verse"), verse.get("text")
                if not isinstance(v, int) or v < 1 or not isinstance(t, str):
                    fail(f"bad verse in {name} {c}")
                t = clean(t)
                entry = {"book": index, "chapter": c, "verse": v, "text": t}
                if t in PLACEHOLDERS:
                    entry["placeholder"] = True
                    placeholder_count += 1
                verses.append(entry)

    # ---- validation
    if not 31000 <= len(verses) <= 31200:
        fail(f"unexpected verse count {len(verses)}")

    def find(b, c, v):
        return next(x["text"] for x in verses if x["book"] == b and x["chapter"] == c and x["verse"] == v)

    checks = {
        (43, 3, 16): "하나님이 세상을 이처럼 사랑하사",
        (19, 23, 1): "여호와는 나의 목자시니",
        (1, 1, 1): "태초에 하나님이 천지를 창조하시니라",
        (66, 22, 21): "주 예수의 은혜",
    }
    for (b, c, v), expect in checks.items():
        got = find(b, c, v)
        if expect not in got:
            fail(f"spot check {books[b - 1]['name']} {c}:{v} failed: {got!r}")

    out = {
        "meta": {
            "translation": "개역한글판",
            "translationEn": "Korean Revised Version (1952/1961)",
            "source": SOURCE_URL,
            "sourceSha256": hashlib.sha256(raw_bytes).hexdigest(),
            "upstream": "CrossWire SWORD module KorRV, text from Korean Wikisource",
            "license": "Public Domain (as declared by the upstream distribution); see data/SOURCE.md",
            "versification": "NRSV",
            "bookCount": len(books),
            "verseCount": len(verses),
            "placeholderVerses": placeholder_count,
        },
        "books": books,
        "verses": verses,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} books={len(books)} verses={len(verses)} placeholders={placeholder_count}")
    for (b, c, v) in checks:
        print(f"  {books[b - 1]['name']} {c}:{v}  {find(b, c, v)}")


if __name__ == "__main__":
    main()
