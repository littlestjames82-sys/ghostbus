# GhostBus FileStore race — verified fix, APPLIED in v0.4.1 (Oct 8, 2026)

Bug: FileStore.save() (src/core.mjs) and saveRegistry() (src/hosted-server.mjs)
both write to one fixed '<file>.tmp' then rename. Concurrent writers collide:
the first rename moves the tmp away, the rest fail ENOENT (seen live as
HTTP 400s during the Ghost Hands v0.4 bus demo).

Proof (stress.mjs, run 2026-10-08):
- Original code: 59/60 concurrent in-process saves failed ENOENT;
  two child processes sharing one store file: 39/40 and 40/40 failed.
- Fixed code (this folder's fixed/ copies): 0 failures in all three runs,
  final file parses as valid JSON.

Fix (fix.patch, applies to src/core.mjs + src/hosted-server.mjs):
1. Unique temp name per save (pid + random suffix) in both places.
2. FileStore.save serializes saves per instance via a promise chain.
3. Temp file cleaned up in a finally block either way.

Apply when Ryan gives a GhostBus stage the word:
  cd ~/workspace/ghostbus && git apply filestore-race-fix/fix.patch
Then re-run: node filestore-race-fix/stress.mjs  (expect NO FAILURES)
and the GhostBus suite (was 41/41 main + 6/6 serverless at v0.4).
