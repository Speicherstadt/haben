/*
 * Nachgebauter Browser für die Skripte aus apps/web/public, die in der Konsole von Lexware Office oder FastBill laufen
 * (lexware-web.test.ts, fastbill-belege-skript.test.ts): Downloads über <a download> und URL.createObjectURL, Pausen über
 * setTimeout ohne echtes Warten.
 */

export interface Download {
  name: string;
  bytes: Uint8Array;
}

/** `globals` mit document, URL und setTimeout für runInConsole; `waits` sammelt die Wartezeiten, `downloads` die gespeicherten Dateien */
export function fakeBrowser() {
  const blobs = new Map<string, Blob>();
  const reads: Promise<void>[] = [];
  const saved: Download[] = [];
  const waits: number[] = [];
  const document = {
    body: { appendChild: () => {} },
    createElement: () => ({
      href: "",
      download: "",
      remove: () => {},
      click() {
        const download: Download = { name: this.download, bytes: new Uint8Array() };
        saved.push(download);
        reads.push(
          blobs
            .get(this.href)!
            .arrayBuffer()
            .then((b) => {
              download.bytes = new Uint8Array(b);
            }),
        );
      },
    }),
  };
  const createObjectURL = (blob: Blob) => {
    const key = `blob:${blobs.size}`;
    blobs.set(key, blob);
    return key;
  };
  // new URL(…) bleibt wie im Browser; nur die Blob-Adressen sind nachgebaut
  const url = new Proxy(URL, {
    get: (target, key) => (key === "createObjectURL" ? createObjectURL : key === "revokeObjectURL" ? () => {} : Reflect.get(target, key)),
  });
  const setTimeout = (fn: () => void, ms = 0) => {
    waits.push(ms);
    setImmediate(fn);
  };
  const downloads = async () => {
    await Promise.all(reads);
    return saved;
  };
  return { globals: { document, URL: url, setTimeout }, waits, downloads };
}

/** Führt Quelltext aus wie in der Konsole, mit `globals` statt der Namen des Browsers; gibt zurück, was der Text zurückgibt */
export function runInConsole(source: string, globals: Record<string, unknown>): unknown {
  const run = new Function(...Object.keys(globals), source) as (...args: unknown[]) => unknown;
  return run(...Object.values(globals));
}
