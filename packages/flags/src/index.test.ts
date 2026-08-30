import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FLAGS, isEnabled, loadFlags, parseFlags } from './index.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('client safety', () => {
  // apps/web bundles `./react` (and through it `./core`) for the browser. A
  // static `node:` import anywhere on that path breaks `next build`, so this
  // guards the boundary at the source level instead of at bundle time.
  it.each(['core.ts', 'react.ts'])('%s has no static node: import', async (file) => {
    const source = await readFile(join(SRC_DIR, file), 'utf8');
    expect(source).not.toMatch(/^\s*import\s[^;]*['"]node:/m);
  });

  it('keeps the node: built-ins in index.ts dynamic', async () => {
    const source = await readFile(join(SRC_DIR, 'index.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s[^;]*['"]node:/m);
    expect(source).toMatch(/await import\('node:fs\/promises'\)/);
  });
});

describe('parseFlags', () => {
  it('accepts a fully valid config unchanged', () => {
    expect(parseFlags({ csv_export: false, contribute_bridge: true })).toEqual({
      csv_export: false,
      contribute_bridge: true,
    });
  });

  it('merges a partial valid config over the defaults', () => {
    expect(parseFlags({ csv_export: false })).toEqual({
      csv_export: false,
      contribute_bridge: DEFAULT_FLAGS.contribute_bridge,
    });
  });

  it('a known flag key holding a non-boolean fails the whole parse closed — no partial salvage', () => {
    // contribute_bridge is validly `true` here, but csv_export is corrupt: the
    // fail-closed contract says the *whole* result must be all-false, not
    // "keep the valid keys, zero out the bad one". A typo on one kill switch
    // must not leave a sibling kill switch silently on.
    expect(parseFlags({ csv_export: 'nope', contribute_bridge: true })).toEqual({
      csv_export: false,
      contribute_bridge: false,
    });
  });

  it('ignores unknown extra keys', () => {
    expect(parseFlags({ csv_export: true, contribute_bridge: true, unknown_flag: true })).toEqual(
      { csv_export: true, contribute_bridge: true },
    );
  });

  it('never throws and falls back to defaults for non-object input', () => {
    expect(parseFlags(null)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags(undefined)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags('nonsense')).toEqual(DEFAULT_FLAGS);
    expect(parseFlags(42)).toEqual(DEFAULT_FLAGS);
    expect(parseFlags([1, 2, 3])).toEqual(DEFAULT_FLAGS);
    expect(() => parseFlags(Symbol('x'))).not.toThrow();
  });
});

describe('isEnabled', () => {
  it('reads the named flag out of a resolved config', () => {
    const flags = { csv_export: true, contribute_bridge: false };
    expect(isEnabled(flags, 'csv_export')).toBe(true);
    expect(isEnabled(flags, 'contribute_bridge')).toBe(false);
  });
});

describe('loadFlags precedence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Point cwd at a fresh, empty temp dir so the always-attempted repo
   * config/flags.json layer is cleanly ABSENT and can't bleed the real
   * (all-true) repo file into a test that means to isolate other layers. */
  async function useEmptyCwd(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    return dir;
  }

  it('an explicit configPath file fully overrides the defaults when no repo config is found', async () => {
    const dir = await useEmptyCwd();
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(filePath, JSON.stringify({ csv_export: false, contribute_bridge: true }));

      const result = await loadFlags({ configPath: filePath, env: {} });

      expect(result).toEqual({ csv_export: false, contribute_bridge: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a partial configPath file merges over the defaults, leaving the other flag at its default', async () => {
    const dir = await useEmptyCwd();
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(filePath, JSON.stringify({ csv_export: true })); // contribute_bridge omitted

      const result = await loadFlags({ configPath: filePath, env: {} });

      expect(result).toEqual({ csv_export: true, contribute_bridge: DEFAULT_FLAGS.contribute_bridge });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('env.FORGE_FLAGS_PATH is honored when configPath is not set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(filePath, JSON.stringify({ csv_export: false, contribute_bridge: true }));

      const result = await loadFlags({ env: { FORGE_FLAGS_PATH: filePath } });

      expect(result).toEqual({ csv_export: false, contribute_bridge: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('walks up from process.cwd() (max 5 levels) to find config/flags.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-flags-walkup-'));
    try {
      const nested = join(root, 'a', 'b', 'c');
      await mkdir(nested, { recursive: true });
      await mkdir(join(root, 'config'), { recursive: true });
      await writeFile(
        join(root, 'config', 'flags.json'),
        JSON.stringify({ csv_export: false, contribute_bridge: false }),
      );

      vi.spyOn(process, 'cwd').mockReturnValue(nested);

      const result = await loadFlags({ env: {} });

      expect(result).toEqual({ csv_export: false, contribute_bridge: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the real repo config/flags.json by walking up from this package', async () => {
    // No mocking: this test relies on `pnpm --filter` running the test
    // script with cwd = packages/flags, two levels below the repo root
    // that owns config/flags.json. config/flags.json — not DEFAULT_FLAGS —
    // is what keeps local/demo behavior enabled (see core.ts).
    const result = await loadFlags({ env: {} });
    expect(result).toEqual({ csv_export: true, contribute_bridge: true });
  });

  it('falls back to all-false defaults when no source is found anywhere above cwd', async () => {
    const dir = await useEmptyCwd();
    try {
      const result = await loadFlags({ env: {} });

      expect(result).toEqual(DEFAULT_FLAGS);
      expect(result).toEqual({ csv_export: false, contribute_bridge: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('composes config/flags.json < FORGE_FLAGS_PATH < FORGE_FLAGS_JSON in order, and untouched flags persist across layers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forge-flags-layers-'));
    try {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      await mkdir(join(dir, 'config'), { recursive: true });
      // Layer 1 (repo config): both flags on.
      await writeFile(
        join(dir, 'config', 'flags.json'),
        JSON.stringify({ csv_export: true, contribute_bridge: true }),
      );
      const pathFile = join(dir, 'override.json');
      // Layer 2 (FORGE_FLAGS_PATH): turns csv_export off, doesn't mention contribute_bridge.
      await writeFile(pathFile, JSON.stringify({ csv_export: false }));

      const result = await loadFlags({
        env: {
          FORGE_FLAGS_PATH: pathFile,
          // Layer 3 (FORGE_FLAGS_JSON): turns csv_export back on, doesn't mention contribute_bridge.
          FORGE_FLAGS_JSON: JSON.stringify({ csv_export: true }),
        },
      });

      // csv_export: true (layer 1) -> false (layer 2) -> true (layer 3): the last layer wins.
      // contribute_bridge: never touched after layer 1, so it survives unchanged.
      expect(result).toEqual({ csv_export: true, contribute_bridge: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores unknown keys in an otherwise-valid layer instead of treating them as invalid', async () => {
    const dir = await useEmptyCwd();
    try {
      const filePath = join(dir, 'flags.json');
      await writeFile(
        filePath,
        JSON.stringify({ csv_export: true, some_future_flag: true, another_unknown: 'x' }),
      );

      const result = await loadFlags({ configPath: filePath, env: {} });

      expect(result).toEqual({ csv_export: true, contribute_bridge: DEFAULT_FLAGS.contribute_bridge });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('fail-closed: a present-but-invalid source zeroes out the whole result', () => {
    it('malformed FORGE_FLAGS_JSON fails closed, even over a valid earlier layer', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        await mkdir(join(dir, 'config'), { recursive: true });
        await writeFile(
          join(dir, 'config', 'flags.json'),
          JSON.stringify({ csv_export: true, contribute_bridge: true }),
        );

        const result = await loadFlags({ env: { FORGE_FLAGS_JSON: '{not valid json' } });

        expect(result).toEqual({ csv_export: false, contribute_bridge: false });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a malformed config/flags.json found by the walk-up itself fails closed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-repo-bad-'));
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        await mkdir(join(dir, 'config'), { recursive: true });
        await writeFile(join(dir, 'config', 'flags.json'), '{not valid json');

        const result = await loadFlags({ env: {} });

        expect(result).toEqual({ csv_export: false, contribute_bridge: false });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a configPath file that is not valid JSON fails closed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-bad-'));
      try {
        const filePath = join(dir, 'flags.json');
        await writeFile(filePath, '{not valid json');

        await expect(loadFlags({ configPath: filePath, env: {} })).resolves.toEqual({
          csv_export: false,
          contribute_bridge: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a FORGE_FLAGS_PATH pointing at a file that does not exist fails closed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-missing-'));
      try {
        const missingPath = join(dir, 'does-not-exist.json');

        const result = await loadFlags({ configPath: missingPath, env: {} });

        expect(result).toEqual({ csv_export: false, contribute_bridge: false });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a known flag key holding a non-boolean fails closed, even when a sibling key in the same layer is validly true', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'forge-flags-'));
      try {
        vi.spyOn(process, 'cwd').mockReturnValue(dir);
        await mkdir(join(dir, 'config'), { recursive: true });
        await writeFile(
          join(dir, 'config', 'flags.json'),
          JSON.stringify({ csv_export: true, contribute_bridge: true }),
        );

        const result = await loadFlags({
          env: { FORGE_FLAGS_JSON: JSON.stringify({ csv_export: 'nope', contribute_bridge: true }) },
        });

        expect(result).toEqual({ csv_export: false, contribute_bridge: false });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a non-object top-level payload fails closed (FORGE_FLAGS_JSON)', async () => {
      const dir = await useEmptyCwd();
      try {
        const result = await loadFlags({ env: { FORGE_FLAGS_JSON: JSON.stringify([1, 2, 3]) } });

        expect(result).toEqual({ csv_export: false, contribute_bridge: false });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a non-object top-level payload fails closed (a file layer)', async () => {
      const dir = await useEmptyCwd();
      try {
        const filePath = join(dir, 'flags.json');
        await writeFile(filePath, JSON.stringify('hello'));

        const result = await loadFlags({ configPath: filePath, env: {} });

        expect(result).toEqual({ csv_export: false, contribute_bridge: false });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('logs the reason once via console.warn when failing closed', async () => {
      const dir = await useEmptyCwd();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await loadFlags({ env: { FORGE_FLAGS_JSON: '{not valid json' } });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.[0]).toContain('FORGE_FLAGS_JSON');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
