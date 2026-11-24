"""Findet Listen, die auf der Website als Fließtext erscheinen.

Python-Markdown beginnt eine Liste nicht mitten in einem Absatz: Fehlt die Leerzeile vor einer Liste
oder vor dem Punkt nach einem eingerückten zweiten Absatz, landen die Punkte als Zeilen im <p>.
zensical build --strict meldet das nicht. Das gebaute HTML behält die Zeilenumbrüche der Quelle;
gesucht wird deshalb jedes <p> mit einer Zeile nach der ersten, die mit "- ", "* ", "+ " oder "1. " beginnt.
Die erste Zeile zählt nicht: Dort steht ein Punkt nur, wenn die Quelle ihn maskiert (1\\. Januar).

Aufruf nach dem Build: python scripts/doku-listen/haben_doku_listen.py site
"""

import re
import sys
from pathlib import Path

ABSATZ = re.compile(r"<p\b[^>]*>(.*?)</p>", re.DOTALL)
LISTENZEILE = re.compile(r"\n[ \t]*(?:[-*+]|\d+\.) ")
TAG = re.compile(r"<[^>]+>")


def listen_im_fliesstext(site: Path) -> list[str]:
    """Gibt je Fund "datei: Textanfang" zurück, sortiert nach Datei."""
    funde = []
    for datei in sorted(site.rglob("*.html")):
        for absatz in ABSATZ.findall(datei.read_text(encoding="utf-8")):
            if LISTENZEILE.search(absatz):
                text = " ".join(TAG.sub("", absatz).split())
                funde.append(f"{datei.relative_to(site)}: {text[:80]}")
    return funde


if __name__ == "__main__":
    funde = listen_im_fliesstext(Path(sys.argv[1]))
    for fund in funde:
        print(fund)
    if funde:
        print(f"{len(funde)} Absätze mit Listenpunkten: Leerzeile vor der Liste bzw. dem Punkt fehlt")
        sys.exit(1)
