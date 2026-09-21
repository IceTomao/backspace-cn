"""Create a machine-translated zh draft from the English locale catalogs.

This is only a draft generator. It preserves i18next placeholders and markup
with tokens; every generated string still needs human review before release.
"""

from __future__ import annotations

import json
import os
import re
import time
from copy import deepcopy
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "packages" / "web" / "src" / "locales" / "en"
TARGET = ROOT / "translation-draft" / "zh"
DELIMITER = "<sep/>"
TOKEN_RE = re.compile(r"\{\{[^{}]+\}\}|</?[^>]+>")


def leaves(value, path=()):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from leaves(child, path + (key,))
    elif isinstance(value, str):
        yield path, value


def put(root, path, value):
    node = root
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value


def protect(text):
    tokens = []

    def replace(match):
        # Digits survive this translation endpoint more reliably than ASCII
        # marker words, which it sometimes drops or turns into quantities.
        token = f"__{987650 + len(tokens)}__"
        tokens.append((token, match.group(0)))
        return token

    return TOKEN_RE.sub(replace, text), tokens


def restore(text, tokens):
    for token, original in tokens:
        number = token.strip("_")
        text = re.sub(rf"__\s*{re.escape(number)}\s*__", original, text)
    return text


def translate_batch(items):
    protected = []
    token_sets = []
    for text in items:
        value, tokens = protect(text)
        protected.append(value)
        token_sets.append(tokens)

    query = quote(DELIMITER.join(protected), safe="")
    url = f"https://api.mymemory.translated.net/get?q={query}&langpair=en%7Czh-CN"
    email = os.environ.get("MYMEMORY_EMAIL")
    if email:
        url += f"&de={quote(email)}"
    request = Request(url, headers={"User-Agent": "Backspace-zh-draft/1.0"})
    with urlopen(request, timeout=45) as response:
        payload = json.load(response)
    translated = payload.get("responseData", {}).get("translatedText", "")
    parts = translated.split("<sep/>")
    if len(parts) != len(items):
        raise RuntimeError(f"batch split mismatch: expected {len(items)}, got {len(parts)}")
    return [restore(part.strip(), tokens) for part, tokens in zip(parts, token_sets)]


def main():
    names = os.environ.get("ZH_DRAFT_NAMES", "common,auth,chat,voice").split(",")
    names = [name.strip() for name in names if name.strip()]
    if os.environ.get("ZH_DRAFT_MISSING_ONLY") == "1":
        names = [name for name in names if not (TARGET / f"{name}.json").exists()]
    TARGET.mkdir(parents=True, exist_ok=True)
    for name in names:
        source_path = SOURCE / f"{name}.json"
        data = json.loads(source_path.read_text(encoding="utf-8"))
        entries = list(leaves(data))
        output = deepcopy(data)
        batches = []
        current = []
        current_len = 0
        single = os.environ.get("ZH_DRAFT_SINGLE") == "1"
        for path, text in entries:
            if not re.search(r"[A-Za-z]", text):
                put(output, path, text)
                continue
            item_len = len(text) + len(DELIMITER)
            risky = "{{" in text or "<" in text
            if risky:
                if current:
                    batches.append(current)
                    current = []
                    current_len = 0
                batches.append([(path, text)])
                continue
            if current and (single or current_len + item_len > 320 or len(current) >= 5):
                batches.append(current)
                current = []
                current_len = 0
            current.append((path, text))
            current_len += item_len
        if current:
            batches.append(current)

        completed = 0
        for batch in batches:
            paths = [path for path, _ in batch]
            texts = [text for _, text in batch]
            try:
                values = translate_batch(texts)
            except Exception as exc:
                print(f"{name}: batch failed ({exc}); retrying items individually")
                values = []
                for text in texts:
                    values.extend(translate_batch([text]))
                    time.sleep(0.25)
            for path, value in zip(paths, values):
                put(output, path, value)
            completed += len(batch)
            print(f"{name}: {completed}/{len(entries)}")
            time.sleep(0.2)

        (TARGET / f"{name}.json").write_text(
            json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
