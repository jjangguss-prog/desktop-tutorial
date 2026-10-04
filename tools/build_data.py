"""성경 본문 데이터 생성 스크립트.

원본: thiagobodruk/bible 의 json/ko_krv.json (개역한글, 1961 — 저작권 보호기간 만료)
  https://raw.githubusercontent.com/thiagobodruk/bible/master/json/ko_krv.json

사용법:
  curl -sSLo ko_krv.json https://raw.githubusercontent.com/thiagobodruk/bible/master/json/ko_krv.json
  python3 tools/build_data.py ko_krv.json

결과:
  js/books.js         — 66권의 이름과 장별 절 수 (읽기표 계산용, 작음)
  data/books/NN.js    — 권별 본문 (그날 필요한 권만 불러옴)
"""
import json
import os
import sys

NAMES = [
    ("창세기", "창"), ("출애굽기", "출"), ("레위기", "레"), ("민수기", "민"), ("신명기", "신"),
    ("여호수아", "수"), ("사사기", "삿"), ("룻기", "룻"), ("사무엘상", "삼상"), ("사무엘하", "삼하"),
    ("열왕기상", "왕상"), ("열왕기하", "왕하"), ("역대상", "대상"), ("역대하", "대하"), ("에스라", "스"),
    ("느헤미야", "느"), ("에스더", "에"), ("욥기", "욥"), ("시편", "시"), ("잠언", "잠"),
    ("전도서", "전"), ("아가", "아"), ("이사야", "사"), ("예레미야", "렘"), ("예레미야애가", "애"),
    ("에스겔", "겔"), ("다니엘", "단"), ("호세아", "호"), ("요엘", "욜"), ("아모스", "암"),
    ("오바댜", "옵"), ("요나", "욘"), ("미가", "미"), ("나훔", "나"), ("하박국", "합"),
    ("스바냐", "습"), ("학개", "학"), ("스가랴", "슥"), ("말라기", "말"),
    ("마태복음", "마"), ("마가복음", "막"), ("누가복음", "눅"), ("요한복음", "요"), ("사도행전", "행"),
    ("로마서", "롬"), ("고린도전서", "고전"), ("고린도후서", "고후"), ("갈라디아서", "갈"), ("에베소서", "엡"),
    ("빌립보서", "빌"), ("골로새서", "골"), ("데살로니가전서", "살전"), ("데살로니가후서", "살후"),
    ("디모데전서", "딤전"), ("디모데후서", "딤후"), ("디도서", "딛"), ("빌레몬서", "몬"), ("히브리서", "히"),
    ("야고보서", "약"), ("베드로전서", "벧전"), ("베드로후서", "벧후"), ("요한일서", "요일"), ("요한이서", "요이"),
    ("요한삼서", "요삼"), ("유다서", "유"), ("요한계시록", "계"),
]


def main(src):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(src, encoding="utf-8-sig") as f:
        books = json.load(f)
    assert len(books) == 66, len(books)

    os.makedirs(os.path.join(root, "data", "books"), exist_ok=True)
    index = []
    for i, (book, (name, short)) in enumerate(zip(books, NAMES), start=1):
        chapters = [[v.strip() for v in ch] for ch in book["chapters"]]
        index.append({"name": name, "short": short, "verses": [len(ch) for ch in chapters]})
        body = json.dumps(chapters, ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(root, "data", "books", f"{i:02d}.js"), "w", encoding="utf-8") as f:
            f.write(f"window.BIBLE_LOAD({i},{body});\n")

    with open(os.path.join(root, "js", "books.js"), "w", encoding="utf-8") as f:
        f.write("// 자동 생성 파일 (tools/build_data.py). 66권의 이름과 장별 절 수.\n")
        f.write("window.BIBLE_BOOKS = [\n")
        for b in index:
            f.write("  " + json.dumps(b, ensure_ascii=False, separators=(",", ":")) + ",\n")
        f.write("];\n")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "ko_krv.json")
