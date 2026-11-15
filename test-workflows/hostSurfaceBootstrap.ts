/// <reference types="mocha" />
/**
 * Startup composition for workflow test bundles.
 *
 * The plugin composes its host surface bridges once in `src/hooks.ts`, so every
 * later code path runs against a configured surface. A workflow test bundle
 * never goes through that startup: `zotero-plugin test` gives every
 * `*.test.ts` under the entries directory its own esbuild entry point and
 * bundles each one separately (see `TestBundler.bundleTests` in
 * zotero-plugin-scaffold — one self-contained IIFE per test file, no code
 * splitting). Each test file therefore carries a private copy of every
 * `src/**` module it imports, including the bridges, which are module
 * singletons. Neither the plugin's composition nor a composition done in some
 * other test file can reach those copies; composition has to happen inside
 * each bundle that contains a bridge.
 *
 * Importing this module registers mocha root hooks in the importing bundle, so
 * that bundle's bridges are composed once before the first test of the run and
 * disposed after the last one — the same lifecycle the plugin gives them.
 * Import it from every workflow test file whose bundle reaches a bridge; when
 * one is missing, the bridge says so by name ("The <name> adapter is not
 * configured for this application surface.").
 *
 * This composes the `src/services/**` host surfaces only, not the plugin's
 * other composition root `composePanelSurfaces` — that one installs the chat
 * renderer, and the scaffold's test bundler has no loader for the agent skill
 * markdown the renderer imports, so pulling it in here stops every workflow
 * bundle from building. No workflow bundle reaches the panel-internal bridges.
 */
import { composeHostSurfaces } from "../src/modules/contextPanel/hostSurfaces";

let disposeHostSurfaces: (() => void) | null = null;

before(function () {
  disposeHostSurfaces?.();
  disposeHostSurfaces = composeHostSurfaces();
});

after(function () {
  disposeHostSurfaces?.();
  disposeHostSurfaces = null;
});
