"""맥체인 성경읽기표 데이터 생성 스크립트.

원본: cwarloe/daily-bible-reading 의 mcheyne.json (Robert Murray M'Cheyne, 1842 — 공개 저작물)
  https://raw.githubusercontent.com/cwarloe/daily-bible-reading/main/mcheyne.json
  (12월 31일: 역대하 36, 요한계시록 22, 말라기 4, 요한복음 21 — 원래 표와 같음을 확인)

사용법:
  curl -sSLo mcheyne.json https://raw.githubusercontent.com/cwarloe/daily-bible-reading/main/mcheyne.json
  python3 tools/build_mcheyne.py mcheyne.json

결과: js/mcheyne.js — 365일 × 4개 본문(가족 1·2, 개인 1·2).
  본문 하나는 [[권, 장], [권, 장, 시작절, 끝절], ...] 형식.
"""
import json
import os
import re
import sys

ORDER = [
    'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth', '1Samuel', '2Samuel',
    '1Kings', '2Kings', '1Chronicles', '2Chronicles', 'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs',
    'Ecclesiastes', 'SongOfSongs', 'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
    'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi',
    'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1Corinthians', '2Corinthians', 'Galatians', 'Ephesians',
    'Philippians', 'Colossians', '1Thessalonians', '2Thessalonians', '1Timothy', '2Timothy', 'Titus', 'Philemon',
    'Hebrews', 'James', '1Peter', '2Peter', '1John', '2John', '3John', 'Jude', 'Revelation',
]
ALIAS = {'Psalm': 'Psalms', 'SongofSongs': 'SongOfSongs', 'SongofSolomon': 'SongOfSongs',
         '1Thes': '1Thessalonians', '2Thes': '2Thessalonians'}
REF = re.compile(r'^([1-3]?\s?[A-Za-z ]+?)\s+(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$')


def book_index(name):
    key = re.sub(r'\s+', '', name)
    key = ALIAS.get(key, key).lower()
    for i, b in enumerate(ORDER, start=1):
        if b.lower() == key:
            return i
    raise ValueError(name)


def parse(ref):
    """'Exodus 11; Exodus 12:1-21' → [[2, 11], [2, 12, 1, 21]]"""
    segs = []
    for part in ref.split(';'):
        m = REF.match(part.strip())
        if not m:
            raise ValueError(ref)
        b = book_index(m.group(1))
        c1, v1, x, v2 = int(m.group(2)), m.group(3), m.group(4), m.group(5)
        if v1 is None and x is None:
            segs.append([b, c1])
        elif v1 is None:
            segs.extend([b, c] for c in range(c1, int(x) + 1))
        elif x is None:
            segs.append([b, c1, int(v1), int(v1)])
        elif v2 is None:
            segs.append([b, c1, int(v1), int(x)])
        else:
            c2 = int(x)
            segs.append([b, c1, int(v1), 999])
            segs.extend([b, c] for c in range(c1 + 1, c2))
            segs.append([b, c2, 1, int(v2)])
    return segs


def main(src):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(src, encoding='utf-8') as f:
        data = json.load(f)
    days = [[parse(r) for r in data[k]['family'] + data[k]['private']] for k in sorted(data)]
    assert len(days) == 365 and all(len(d) == 4 for d in days)
    with open(os.path.join(root, 'js', 'mcheyne.js'), 'w', encoding='utf-8') as f:
        f.write('// 자동 생성 파일 (tools/build_mcheyne.py). 맥체인 성경읽기표 365일 × [가족 1, 가족 2, 개인 1, 개인 2].\n')
        f.write('window.MCHEYNE = [\n')
        for d in days:
            f.write('  ' + json.dumps(d, separators=(',', ':')) + ',\n')
        f.write('];\n')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'mcheyne.json')
