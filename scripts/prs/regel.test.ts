import { describe, expect, it } from "vitest";
import { ci, lage, type PullRequest, rangliste, selbstpruefungAktuell } from "./regel.ts";

const pr = (teil: Partial<PullRequest> = {}): PullRequest => ({
  number: 1,
  title: "Bank: x",
  author: { login: "jemand" },
  isDraft: false,
  isCrossRepository: false,
  mergeable: "MERGEABLE",
  headRefOid: "abcdef1234567890",
  createdAt: "2026-11-01T00:00:00Z",
  files: [{ path: "apps/web/src/routes/bank.tsx" }],
  statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  comments: [],
  commits: [{ committedDate: "2026-11-01T00:00:00Z" }],
  ...teil,
});
const M = ["firsttris"];
const kommentar = (login: string, createdAt: string, body = "Danke!") => ({ author: { login }, body, createdAt });

describe("ci", () => {
  it("unterscheidet grün, rot, läuft und nicht gelaufen", () => {
    expect(ci([]).ci).toBe("nicht gelaufen");
    expect(ci([{ status: "COMPLETED", conclusion: "SUCCESS" }]).ci).toBe("grün");
    expect(ci([{ status: "IN_PROGRESS", conclusion: null }]).ci).toBe("läuft");
    expect(ci([{ state: "PENDING" }]).ci).toBe("läuft");
    expect(ci([{ name: "e2e", status: "COMPLETED", conclusion: "FAILURE" }])).toEqual({ ci: "rot", rot: ["e2e"] });
  });
});

describe("lage", () => {
  it("klein und grün: Platz 2", () => {
    expect(lage(pr(), M).platz).toBe(2);
  });

  it("heikel, Migration oder groß: Platz 3", () => {
    expect(lage(pr({ files: [{ path: "packages/core/src/ust.ts" }] }), M)).toMatchObject({ platz: 3, heikel: true });
    expect(lage(pr({ files: [{ path: "apps/web/drizzle/0400_x.sql" }] }), M)).toMatchObject({ platz: 3, migrationen: ["apps/web/drizzle/0400_x.sql"] });
    expect(lage(pr({ files: Array.from({ length: 15 }, (_, i) => ({ path: `apps/web/src/a${i}.ts` })) }), M).grund).toBe("groß");
  });

  it("Konflikt oder rote CI: Platz 5", () => {
    expect(lage(pr({ mergeable: "CONFLICTING" }), M).platz).toBe(5);
    expect(lage(pr({ statusCheckRollup: [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }] }), M).grund).toContain("lint");
  });

  it("unser Kommentar zuletzt: Platz 6, danach neue Commits: Platz 4", () => {
    const comments = [kommentar("firsttris", "2026-11-02T00:00:00Z")];
    expect(lage(pr({ comments }), M).platz).toBe(6);
    expect(lage(pr({ comments, commits: [{ committedDate: "2026-11-03T00:00:00Z" }] }), M).platz).toBe(4);
  });

  it("eigener Pull Request des Maintainers mit seiner Selbstprüfung wartet nicht auf den Autor", () => {
    const comments = [kommentar("firsttris", "2026-11-02T00:00:00Z", "## Selbstprüfung (beitrag-pruefen)\nStand: abcdef1")];
    expect(lage(pr({ author: { login: "firsttris" }, comments }), M).platz).toBe(2);
  });

  it("eigener Pull Request eines von mehreren Maintainern: Kommentare des anderen bleiben Befunde", () => {
    const comments = [kommentar("zweite", "2026-11-02T00:00:00Z")];
    expect(lage(pr({ author: { login: "firsttris" }, comments }), ["firsttris", "zweite"]).platz).toBe(6);
  });

  it("Fork ohne aktuelle Selbstprüfung: Platz 7, Nachbesserung auf unsere Befunde trotzdem Platz 4", () => {
    expect(lage(pr({ isCrossRepository: true }), M).platz).toBe(7);
    const comments = [kommentar("firsttris", "2026-11-02T00:00:00Z")];
    expect(lage(pr({ isCrossRepository: true, comments, commits: [{ committedDate: "2026-11-03T00:00:00Z" }] }), M).platz).toBe(4);
  });
});

describe("selbstpruefungAktuell", () => {
  it("braucht die Überschrift und den Head", () => {
    const body = "## Selbstprüfung (beitrag-pruefen)\nStand: abcdef1";
    expect(selbstpruefungAktuell([kommentar("jemand", "x", body)], "abcdef1234")).toBe(true);
    expect(selbstpruefungAktuell([kommentar("jemand", "x", body)], "9999999999")).toBe(false);
    expect(selbstpruefungAktuell([kommentar("jemand", "x", "Stand: abcdef1")], "abcdef1234")).toBe(false);
  });
});

describe("rangliste", () => {
  it("ohne Entwürfe, nach Platz und Alter", () => {
    const liste = rangliste(
      [
        pr({ number: 3, createdAt: "2026-11-03T00:00:00Z" }),
        pr({ number: 2, createdAt: "2026-11-02T00:00:00Z" }),
        pr({ number: 9, isDraft: true }),
        pr({ number: 1, mergeable: "CONFLICTING" }),
      ],
      M,
    );
    expect(liste.map((l) => l.number)).toEqual([2, 3, 1]);
  });
});
