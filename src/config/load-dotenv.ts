// Loads a local `.env` file into process.env when one is present, without
// adding a `dotenv` dependency.
//
// adversarial-review finding: the quick-start docs (README) tell a local
// developer to `cp .env.example .env` and edit it, but nothing ever
// actually read that file — `tsx`/npm don't load `.env` implicitly, so
// every value in it was silently ignored outside a shell that happened to
// export it manually.
//
// This can't be fixed by adding `--env-file=.env` to the affected npm
// scripts: docs/TRD.md §7/§8 document `npm run migrate` as the exact
// command Render/Railway/Fly run in production, where the real config
// comes from platform-injected env vars and no `.env` file exists at all
// — `node --env-file=.env` hard-fails (and exits) when the named file is
// missing, which would break every one of those deploys. The newer
// `--env-file-if-exists` flag would dodge that, but it needs Node >=22.9,
// newer than this repo's `engines.node` (`>=20`) and its Dockerfile's
// `node:20-slim` base actually support. `process.loadEnvFile()` (Node
// >=20.12) gives the same "load it if present, otherwise carry on"
// behavior at the JS level instead, so every entrypoint below calls it
// unconditionally and it's a no-op whenever the file just doesn't exist.
export function loadDotEnvIfPresent(): void {
  const loadEnvFile = (process as unknown as { loadEnvFile?: (path?: string) => void }).loadEnvFile;
  if (typeof loadEnvFile !== 'function') {
    // Node <20.12: no built-in loader available. Falling through leaves
    // process.env exactly as the shell provided it — the same behavior
    // this repo had before this fix, just no worse.
    return;
  }
  try {
    loadEnvFile.call(process);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  }
}
