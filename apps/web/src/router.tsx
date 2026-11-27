import { createRouter } from "@tanstack/react-router";
import { NichtGefunden, SeitenFehler, SeitenLaden } from "./components/Fehlerseiten.tsx";
import { appContextCache } from "./lib/app-navigation.ts";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPendingComponent: SeitenLaden,
    defaultNotFoundComponent: NichtGefunden,
    defaultErrorComponent: SeitenFehler,
    // Jede Seite entsteht je Pfad-Parameter neu: Beim Wechsel zu einem anderen Eintrag (etwa über die Schnellsuche) gehören
    // Formular, Meldungen und Rückfragen sonst weiter zum vorigen (#1839, #1843). Suchparameter wie ?jahr= lassen die Seite stehen
    defaultRemountDeps: ({ params }) => params,
  });
  const invalidate = router.invalidate.bind(router);
  router.invalidate = (opts) => {
    appContextCache.clear();
    return invalidate(opts);
  };
  const clearCache = router.clearCache.bind(router);
  router.clearCache = (opts) => {
    appContextCache.clear();
    return clearCache(opts);
  };
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
