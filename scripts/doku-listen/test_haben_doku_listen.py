"""Tests: python -m unittest discover -s scripts/doku-listen"""

import tempfile
import unittest
from pathlib import Path

from haben_doku_listen import listen_im_fliesstext


class ListenImFliesstext(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.site = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def seite(self, name: str, inhalt: str):
        datei = self.site / name
        datei.parent.mkdir(parents=True, exist_ok=True)
        datei.write_text(f"<html><body>{inhalt}</body></html>", encoding="utf-8")

    def test_absatz_direkt_vor_der_liste(self):
        self.seite("gmbh.html", "<p><strong>Steuerabzug</strong> so:\n- <strong>Ohne</strong> 25 %.\n- Mit</p>")
        self.assertEqual(listen_im_fliesstext(self.site), ["gmbh.html: Steuerabzug so: - Ohne 25 %. - Mit"])

    def test_zweiter_absatz_im_punkt_und_nummerierte_liste(self):
        self.seite("adr/a.html", '<li><p>Erster</p>\n<p class="x">Zweiter Absatz.\n3. <strong>Dritter</strong></p></li>')
        self.seite("b.html", "<p>Text\n  * Stern</p>")
        self.assertEqual(
            listen_im_fliesstext(self.site),
            ["adr/a.html: Zweiter Absatz. 3. Dritter", "b.html: Text * Stern"],
        )

    def test_echte_listen_und_striche_im_text_bleiben(self):
        self.seite(
            "c.html",
            "<p>Vom 1. Januar - bis 31. Dezember, -5 % und 2.5</p>\n<ul>\n<li>Punkt</li>\n</ul>\n"
            "<ol>\n<li><p>Locker</p>\n</li>\n</ol>\n<pre><code>- yaml\n1. code</code></pre>",
        )
        self.assertEqual(listen_im_fliesstext(self.site), [])

    def test_plus_als_listenpunkt(self):
        # Python-Markdown kennt -, * und + als Punkt einer Liste
        self.seite("d.html", "<p>Text:\n+ plus eins\n+ plus zwei</p>")
        self.assertEqual(listen_im_fliesstext(self.site), ["d.html: Text: + plus eins + plus zwei"])

    def test_maskierter_punkt_am_anfang_des_absatzes_bleibt(self):
        # 1\. Januar und \- in der Quelle: keine Liste, im HTML steht "1. " bzw. "- " am Anfang des <p>
        self.seite("e.html", "<p>1. Januar 2027 gilt das.</p>\n<p>- kein Punkt</p>")
        self.assertEqual(listen_im_fliesstext(self.site), [])


if __name__ == "__main__":
    unittest.main()
