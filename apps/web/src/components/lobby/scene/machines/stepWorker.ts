/**
 * Reads a STEP file off the page's thread: loads the CAD reader
 * (occt-import-js, OpenCascade compiled to WebAssembly, about 7.6 MB, fetched
 * only when a STEP file is opened) and meshes every solid in the file.
 *
 * The reader's files are served untouched (they're emitted as assets, not
 * bundled: its loader reaches for Node's fs, path and crypto, which a bundle
 * can't give it), and pulled in with importScripts, so this is a classic
 * worker. It says what it's doing as it goes: `engine` while the reader
 * loads, `reading` while it reads, then the meshes (or why not).
 *
 * The reader and OpenCascade are LGPL-2.1, used as they come (a separate
 * script and .wasm, replaceable): their licences are served from
 * /licenses/occt-import-js.txt and /licenses/open-cascade.txt.
 */

/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope & {
  occtimportjs?: (overrides: { locateFile(path: string): string }) => Promise<{
    ReadStepFile(content: Uint8Array, params: unknown): unknown;
  }>;
};

const READER = new URL('occt-import-js/dist/occt-import-js.js', import.meta.url).href;
const WASM = new URL('occt-import-js/dist/occt-import-js.wasm', import.meta.url).href;

/** Fine enough for a machine a metre or two across; coarse enough to stay a few megabytes. */
const MESHING = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.002,
  angularDeflection: 0.5,
};

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer }>) => {
  try {
    self.postMessage({ stage: 'engine' });
    if (!self.occtimportjs) self.importScripts(READER);
    const occt = await self.occtimportjs!({ locateFile: () => WASM });
    self.postMessage({ stage: 'reading' });
    const result = occt.ReadStepFile(new Uint8Array(event.data.buffer), MESHING) as { meshes?: { attributes?: Record<string, { array?: unknown }>; index?: { array?: unknown } }[] };
    // Hand the meshes back as typed arrays, moved rather than copied.
    const moved: ArrayBuffer[] = [];
    for (const mesh of result.meshes ?? []) {
      for (const attribute of [mesh.attributes?.position, mesh.attributes?.normal, mesh.index]) {
        if (!attribute || !Array.isArray(attribute.array)) continue;
        const typed = attribute === mesh.index ? Uint32Array.from(attribute.array as number[]) : Float32Array.from(attribute.array as number[]);
        attribute.array = typed;
        moved.push(typed.buffer);
      }
    }
    self.postMessage({ result }, moved);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
