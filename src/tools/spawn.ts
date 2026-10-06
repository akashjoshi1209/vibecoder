/**
 * Thin seam between tool implementations and the process runner.
 *
 * Tool code imports { spawnCollect } through this module instead of straight
 * from ./proc so a test can stub the runner for one tool without replacing
 * ./proc for every importer in the process. mock.module("./proc") swaps the
 * module for ALL importers, so stubing it to test network_ping would silently
 * neuter grep and bash too - they share the same spawnCollect.
 *
 * This is deliberately a wrapping function, not `export { spawnCollect } from
 * "./proc"`. Bun's mock.module on a live re-export rewires the source module's
 * bindings too (observed on bun 1.4.2), which leaks the stub into ./proc for
 * every importer. A plain function that calls through keeps the two modules
 * independent.
 */
import { spawnCollect as runProcess, type SpawnCollectOptions, type SpawnCollectResult } from "./proc";

export function spawnCollect(opts: SpawnCollectOptions): Promise<SpawnCollectResult> {
  return runProcess(opts);
}