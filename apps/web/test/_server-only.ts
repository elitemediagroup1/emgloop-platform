// A stand-in for Next's `server-only` marker module, for the test process ONLY.
//
// WHY THIS EXISTS. `server-only` is not a package anybody installs; Next provides
// it, and importing it is how a module declares "this must never reach the
// browser". A plain node test process has no Next resolver, so any test that
// transitively loads a server module fails to resolve it.
//
// IT IS MAPPED IN `tsconfig.test.json` AND NOWHERE ELSE, so the production build
// still resolves the real marker and the guarantee it provides is unchanged. A
// stub in the app itself would have silently disabled that guarantee everywhere.
export {};
