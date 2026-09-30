import { describe, expect, it } from 'vitest';

import {
  APPS,
  appAt,
  appBySlug,
  frameOrigin,
  isHostName,
  isValidSlug,
  parseHttpsUrl,
  sandboxFor,
  validateRegistry,
} from './registry.js';
import type { AppEntry } from './registry.js';

// The runtime's own WHATWG URL parser, as the browser will use it for an
// iframe src. Reached through globalThis because this package's tsconfig
// deliberately has no DOM or Node types.
const WhatwgUrl = (globalThis as unknown as { URL: new (input: string) => { origin: string } }).URL;

const FORGE = { forgeHost: 'forge.example', allowedSuffixes: ['forgeapps.example'] } as const;

/** A framed app that passes validateRegistry with FORGE, to break one field at a time. */
function framed(overrides: Record<string, unknown> = {}): AppEntry {
  return {
    slug: 'cards',
    title: 'Cards',
    description: 'A card table',
    hosting: 'framed',
    route: 'https://cards.forgeapps.example/play',
    slot: { col: 1, row: 3 },
    media: { kind: 'image', src: '/lobby/cards.png' },
    lit: true,
    ...overrides,
  } as AppEntry;
}

/** A native app that passes validateRegistry, to break one field at a time. */
function native(overrides: Record<string, unknown> = {}): AppEntry {
  return {
    slug: 'maps',
    title: 'Maps',
    description: 'City maps',
    hosting: 'native',
    route: '/apps/maps',
    slot: { col: 2, row: 3 },
    media: { kind: 'generated' },
    lit: false,
    ...overrides,
  } as AppEntry;
}

const check = (apps: readonly unknown[], opts?: Parameters<typeof validateRegistry>[1]) => () =>
  validateRegistry(apps as readonly AppEntry[], opts);

describe('APPS', () => {
  it('is exactly the Data app, lit, native, in slot 0, showing the lobby screen video and its 360p encode', () => {
    expect(APPS).toEqual([
      {
        slug: 'data',
        title: 'Data',
        description: 'Upland blockchain data',
        hosting: 'native',
        route: '/apps/data',
        slot: { col: 0, row: 0 },
        media: {
          kind: 'video',
          src: '/lobby/lobby-screen.mp4',
          srcLow: '/lobby/lobby-screen-360.mp4',
          poster: '/lobby/lobby-screen-poster.jpg',
        },
        lit: true,
      },
    ]);
  });

  it('passes validateRegistry on its own, and with framing options supplied', () => {
    expect(() => validateRegistry(APPS)).not.toThrow();
    expect(() => validateRegistry(APPS, FORGE)).not.toThrow();
  });

  it('is deeply frozen, so no importer can quietly rewrite the registry', () => {
    const data = APPS[0];
    expect(Object.isFrozen(APPS)).toBe(true);
    expect(data && Object.isFrozen(data)).toBe(true);
    expect(data && Object.isFrozen(data.slot)).toBe(true);
    expect(data && Object.isFrozen(data.media)).toBe(true);
  });
});

describe('appBySlug and appAt', () => {
  it('look apps up by slug and by slot', () => {
    expect(appBySlug('data')).toBe(APPS[0]);
    expect(appBySlug('DATA')).toBeUndefined();
    expect(appBySlug('nope')).toBeUndefined();
    expect(appBySlug('')).toBeUndefined();
    expect(appAt({ col: 0, row: 0 })).toBe(APPS[0]);
    expect(appAt({ col: 32, row: 0 })).toBe(APPS[0]);
    expect(appAt({ col: 1, row: 0 })).toBeUndefined();
    expect(appAt({ col: 0, row: 1 })).toBeUndefined();
    expect(appAt({ col: 1, row: 3 }, [framed()])?.slug).toBe('cards');
  });
});

describe('validateRegistry: slugs and slots', () => {
  it('rejects a duplicate slug', () => {
    expect(check([...APPS, native({ slug: 'data', route: '/apps/data/other' })])).toThrow(/slug "data" is already taken/);
  });

  it('only accepts 1–32 lowercase letters, digits and inner hyphens', () => {
    for (const slug of ['a', 'data', 'upland-maps', 'a1', 'x'.repeat(32)]) {
      expect(isValidSlug(slug)).toBe(true);
    }
    for (const slug of ['', 'Data', '-maps', 'maps-', 'my_app', 'a/b', 'a.b', 'x'.repeat(33), ' maps', 'mäps', 42, null]) {
      expect(isValidSlug(slug)).toBe(false);
    }
    expect(check([native({ slug: 'Maps', route: '/apps/Maps' })])).toThrow(/slug must match/);
  });

  it('rejects a duplicate slot', () => {
    expect(check([...APPS, native({ slot: { col: 0, row: 0 } })])).toThrow(/slot col 0, row 0 is already taken/);
  });

  it('accepts any slot on the 32 × 90 wall, corners included', () => {
    for (const slot of [
      { col: 31, row: 0 },
      { col: 0, row: 89 },
      { col: 31, row: 89 },
      { col: 12, row: 7 },
    ]) {
      expect(check([native({ slot })])).not.toThrow();
    }
  });

  it('rejects slots outside the 32 × 90 grid, or not written canonically', () => {
    for (const slot of [
      { col: 32, row: 0 },
      { col: -1, row: 0 },
      { col: 0, row: 90 },
      { col: 0, row: -1 },
      { col: 1.5, row: 0 },
      { col: '1', row: 0 },
      { col: 1 },
      null,
    ]) {
      expect(check([native({ slot })])).toThrow(
        /slot must be whole numbers inside the 32×90 grid \(col 0\.\.31, row 0\.\.89\)/,
      );
    }
  });
});

describe('validateRegistry: native routes', () => {
  it('accepts /apps/<slug> and lowercase segments under it', () => {
    expect(check([native()])).not.toThrow();
    expect(check([native({ route: '/apps/maps/city/new-york' })])).not.toThrow();
  });

  it('rejects anything that is not an internal /apps/<slug> path', () => {
    for (const route of [
      '/apps',
      '/apps/',
      '/apps/maps/',
      '/apps/data',
      '/apps/mapsx',
      '/me',
      '//evil.example/apps/maps',
      'https://forge.example/apps/maps',
      '/apps/maps?tab=1',
      '/apps/maps#top',
      '/apps/maps/../../me',
      '/apps/maps/./x',
      '/apps/maps//x',
      '/apps/maps/City',
      '/apps/maps\\x',
      '/apps/maps/%2e%2e',
      ' /apps/maps',
      42,
    ]) {
      expect(check([native({ route })])).toThrow(/a native route must be/);
    }
  });

  it('refuses sandbox opt-ins on a native app', () => {
    expect(check([native({ sandbox: { allowPopups: true } })])).toThrow(/sandbox opt-ins apply only to framed apps/);
  });
});

describe('validateRegistry: framed apps (fixtures; nothing framed ships yet)', () => {
  it('accepts a well-formed framed app when FORGE’s host and the suffix allowlist are supplied', () => {
    expect(check([...APPS, framed()], FORGE)).not.toThrow();
    expect(check([framed({ route: 'https://forgeapps.example' })], FORGE)).not.toThrow();
    expect(check([framed({ sandbox: { allowPopups: true, allowDownloads: false } })], FORGE)).not.toThrow();
    expect(check([framed()], { forgeHost: 'forge.example', allowedSuffixes: ['.forgeapps.example'] })).not.toThrow();
  });

  it('is refused unless BOTH forgeHost and allowedSuffixes are supplied', () => {
    const refused = /needs opts.forgeHost and opts.allowedSuffixes/;
    expect(check([framed()])).toThrow(refused);
    expect(check([framed()], {})).toThrow(refused);
    expect(check([framed()], { forgeHost: 'forge.example' })).toThrow(refused);
    expect(check([framed()], { allowedSuffixes: ['forgeapps.example'] })).toThrow(refused);
  });

  it('needs an https: URL with no credentials, port, query or fragment', () => {
    const cases: Array<[string, RegExp]> = [
      ['http://cards.forgeapps.example/', /must be an https: URL/],
      ['HTTPS://cards.forgeapps.example/', /must be an https: URL/],
      ['//cards.forgeapps.example/', /must be an https: URL/],
      ['/apps/cards', /must be an https: URL/],
      ['javascript:alert(1)', /must be an https: URL/],
      ['https://user:pass@cards.forgeapps.example/', /must not carry credentials/],
      ['https://cards.forgeapps.example@evil.example/', /must not carry credentials/],
      ['https://cards.forgeapps.example:8443/', /must not name a port/],
      ['https://cards.forgeapps.example:443/', /must not name a port/],
      ['https://cards.forgeapps.example/?x=1', /must not carry a query/],
      ['https://cards.forgeapps.example?x=1', /must not carry a query/],
      ['https://cards.forgeapps.example/#top', /must not carry a fragment/],
      ['https://cards.forgeapps.example/a b', /printable ASCII/],
      ['https://cards.forgeapps.example/\tx', /printable ASCII/],
      ['https://cards.forgeapps.exa\nmple/', /printable ASCII/],
      ['https://cards.forgeapps.example\\@evil.example/', /printable ASCII/],
      ['https://Cards.forgeapps.example/', /lowercase DNS host/],
      ['https://cards.forgeapps.example./', /lowercase DNS host/],
      ['https://-cards.forgeapps.example/', /lowercase DNS host/],
      ['https:///cards', /lowercase DNS host/],
      ['https://*.forgeapps.example/', /lowercase DNS host/],
      ['https://cards.forgeapps.example/%2e%2e/x', /unreserved characters/],
      ["https://cards.forgeapps.example/a'b", /unreserved characters/],
    ];
    for (const [route, reason] of cases) {
      expect(check([framed({ route })], FORGE)).toThrow(reason);
    }
    expect(check([framed({ route: 42 })], FORGE)).toThrow(/a framed route must be a string \(got 42\)/);
    expect(check([framed({ route: undefined })], FORGE)).toThrow(/a framed route must be a string \(got undefined\)/);
  });

  it('keeps the framed host on an allowlisted suffix, matched on whole labels', () => {
    expect(check([framed({ route: 'https://cards.evil.example/' })], FORGE)).toThrow(/not under any allowlisted suffix/);
    expect(check([framed({ route: 'https://evilforgeapps.example/' })], FORGE)).toThrow(/not under any allowlisted suffix/);
    expect(check([framed({ route: 'https://forgeapps.example.evil.example/' })], FORGE)).toThrow(
      /not under any allowlisted suffix/,
    );
    expect(check([framed()], { forgeHost: 'forge.example', allowedSuffixes: [] })).toThrow(/not under any allowlisted suffix/);
  });

  it('never frames FORGE itself or anything under its host', () => {
    const opts = { forgeHost: 'forge.example', allowedSuffixes: ['forge.example'] };
    expect(check([framed({ route: 'https://forge.example/' })], opts)).toThrow(/FORGE's own host/);
    expect(check([framed({ route: 'https://cards.forge.example/' })], opts)).toThrow(/FORGE's own host/);
  });

  it('refuses a pair that could share a registrable domain', () => {
    // FORGE at www.forge.example and apps under apps.forge.example: neither
    // host sits under the other, but both are forge.example's.
    expect(
      check([framed({ route: 'https://cards.apps.forge.example/' })], {
        forgeHost: 'www.forge.example',
        allowedSuffixes: ['apps.forge.example'],
      }),
    ).toThrow(/sits under forge.example, the domain of the matched suffix apps.forge.example/);
    // Without the Public Suffix List a shared platform domain is refused too: fail closed.
    expect(
      check([framed({ route: 'https://cards.vercel.app/' })], { forgeHost: 'forge.vercel.app', allowedSuffixes: ['vercel.app'] }),
    ).toThrow(/sits under vercel.app/);
  });

  it('validates the options themselves', () => {
    expect(check([framed()], { forgeHost: 'Forge.Example', allowedSuffixes: ['forgeapps.example'] })).toThrow(
      /opts.forgeHost must be a lowercase host name/,
    );
    expect(check([framed()], { forgeHost: 'https://forge.example', allowedSuffixes: ['forgeapps.example'] })).toThrow(
      /opts.forgeHost must be a lowercase host name/,
    );
    for (const suffix of ['example', 'forgeapps.example.', 'Forge.example', '*.example', '1.2.3.4', '', 7]) {
      expect(check([framed()], { forgeHost: 'forge.example', allowedSuffixes: [suffix as string] })).toThrow(
        /is not a domain of at least two labels/,
      );
    }
    // A single-label FORGE host (a local dev server) is fine.
    expect(check([framed()], { forgeHost: 'localhost', allowedSuffixes: ['forgeapps.example'] })).not.toThrow();
  });

  it('only accepts allowPopups and allowDownloads, as booleans', () => {
    for (const sandbox of [{ allowPopups: 'yes' }, { allowTopNavigation: true }, { allowModals: true }, 'allow-popups', null]) {
      expect(check([framed({ sandbox })], FORGE)).toThrow(/sandbox may only hold allowPopups and allowDownloads/);
    }
  });
});

describe('validateRegistry: the rest of each entry', () => {
  it('needs a title, a description, a boolean lit and a known hosting', () => {
    expect(check([native({ title: '' })])).toThrow(/title must be a non-empty string/);
    expect(check([native({ description: '   ' })])).toThrow(/description must be a non-empty string/);
    expect(check([native({ lit: 'yes' })])).toThrow(/lit must be a boolean/);
    expect(check([native({ hosting: 'iframe' })])).toThrow(/hosting must be "native" or "framed"/);
  });

  it('only loads media from FORGE’s own origin, by root-relative path', () => {
    const ok = [
      { kind: 'generated' },
      { kind: 'image', src: '/lobby/maps.png' },
      { kind: 'video', src: '/lobby/maps.mp4', poster: '/lobby/maps.jpg' },
      { kind: 'video', src: '/lobby/maps.mp4', srcLow: '/lobby/maps-360.mp4', poster: '/lobby/maps.jpg' },
    ];
    for (const media of ok) {
      expect(check([native({ media })])).not.toThrow();
    }
    const bad: Array<[unknown, RegExp]> = [
      [{ kind: 'video', src: '/a.mp4', srcLow: '', poster: '/a.jpg' }, /media.srcLow/],
      [{ kind: 'video', src: '/a.mp4', srcLow: null, poster: '/a.jpg' }, /media.srcLow/],
      [{ kind: 'image', src: '//evil.example/x.png' }, /media.src/],
      [{ kind: 'image', src: 'http://evil.example/x.png' }, /media.src/],
      [{ kind: 'image', src: 'javascript:alert(1)' }, /media.src/],
      [{ kind: 'image', src: 'data:image/png;base64,AAAA' }, /media.src/],
      [{ kind: 'image', src: '/lobby/a b.png' }, /media.src/],
      [{ kind: 'image' }, /media.src/],
      [{ kind: 'video', src: '/lobby/a.mp4' }, /media.poster/],
      [{ kind: 'video', src: 'x', poster: '/a.jpg' }, /media.src/],
      [{ kind: 'gif', src: '/a.gif' }, /media.kind must be/],
      ['generated', /media must be an object/],
    ];
    for (const [media, reason] of bad) {
      expect(check([native({ media })])).toThrow(reason);
    }
  });

  it('refuses media with a scheme, https included: the scene samples its pixels, and cross-origin ones would taint them', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ kind: 'image', src: 'https://cdn.forgeapps.example/maps.png' }, /media.src must be a root-relative path/],
      [{ kind: 'video', src: 'https://cdn.evil.example/v.mp4', poster: '/a.jpg' }, /media.src/],
      [{ kind: 'video', src: '/a.mp4', poster: 'https://cdn.forgeapps.example/a.jpg' }, /media.poster/],
      [{ kind: 'video', src: '/a.mp4', srcLow: 'https://cdn.forgeapps.example/a.mp4', poster: '/a.jpg' }, /media.srcLow/],
      [{ kind: 'image', src: 'blob:https://forge.example/1' }, /media.src/],
    ];
    for (const [media, reason] of bad) {
      expect(check([native({ media })])).toThrow(reason);
    }
  });

  it('lists every problem at once, naming each entry', () => {
    let message = '';
    try {
      validateRegistry([native({ title: '', lit: 1 }), framed({ slug: 'Bad Slug' })] as readonly AppEntry[]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^App registry is invalid:/);
    expect(message).toContain('apps[0] (maps): title must be a non-empty string');
    expect(message).toContain('apps[0] (maps): lit must be a boolean');
    expect(message).toContain('apps[1] (Bad Slug): slug must match');
    expect(message).toContain('apps[1] (Bad Slug): a framed app needs');
  });

  it('fails closed on input that is not a registry at all', () => {
    expect(check('data' as unknown as unknown[])).toThrow(/not an array/);
    expect(check([null])).toThrow(/apps\[0\]: is not an object/);
    expect(check([['data']])).toThrow(/apps\[0\]: is not an object/);
    expect(check([native({ slug: Symbol('s') })])).toThrow(/got a symbol/);
    expect(check([native({ slug: 10n })])).toThrow(/got a bigint/);
    expect(check([native({ route: { path: '/apps/maps' } })])).toThrow(/got an object/);
  });
});

describe('sandboxFor', () => {
  it('gives a framed app scripts, same-origin and forms, and nothing more by default', () => {
    expect(sandboxFor(framed())).toBe('allow-scripts allow-same-origin allow-forms');
  });

  it('adds popups and downloads only on an explicit opt-in', () => {
    expect(sandboxFor(framed({ sandbox: { allowPopups: true } }))).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups',
    );
    expect(sandboxFor(framed({ sandbox: { allowDownloads: true } }))).toBe(
      'allow-scripts allow-same-origin allow-forms allow-downloads',
    );
    expect(sandboxFor(framed({ sandbox: { allowPopups: true, allowDownloads: true } }))).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads',
    );
    expect(sandboxFor(framed({ sandbox: { allowPopups: 'true', allowDownloads: 1 } }))).toBe(
      'allow-scripts allow-same-origin allow-forms',
    );
  });

  it('never grants top navigation or modals, whatever the entry says', () => {
    const everything = framed({ sandbox: { allowPopups: true, allowDownloads: true, allowTopNavigation: true, allowModals: true } });
    expect(sandboxFor(everything)).not.toMatch(/top-navigation|modals|escape-sandbox/);
  });

  it('throws on a native app', () => {
    expect(() => sandboxFor(APPS[0] as AppEntry)).toThrow(/"data" is not a framed app/);
    expect(() => sandboxFor(native({ hosting: 'other' }))).toThrow(/not a framed app/);
  });
});

describe('frameOrigin', () => {
  it('is null for a native app', () => {
    expect(frameOrigin(APPS[0] as AppEntry)).toBeNull();
  });

  it('is the origin the browser will load, for every route validateRegistry accepts', () => {
    for (const route of [
      'https://cards.forgeapps.example/play',
      'https://cards.forgeapps.example',
      'https://cards.forgeapps.example/',
      'https://a-b.c1.forgeapps.example/deep/path/index.html',
      'https://forgeapps.example/~user/x_y.z',
    ]) {
      const app = framed({ route });
      expect(() => validateRegistry([app], FORGE)).not.toThrow();
      expect(frameOrigin(app)).toBe(new WhatwgUrl(route).origin);
    }
  });

  it('throws for a framed route it cannot parse strictly, instead of guessing an origin', () => {
    expect(() => frameOrigin(framed({ route: 'https://cards.forgeapps.example:443/' }))).toThrow(/must not name a port/);
    expect(() => frameOrigin(framed({ route: 'http://cards.forgeapps.example/' }))).toThrow(/https: URL/);
  });
});

describe('parseHttpsUrl and isHostName', () => {
  it('parse strictly', () => {
    expect(parseHttpsUrl('https://a.example/x')).toEqual({ ok: true, host: 'a.example' });
    expect(parseHttpsUrl(42 as unknown as string)).toEqual({ ok: false, reason: 'must be an https: URL' });
    expect(isHostName('a.example')).toBe(true);
    expect(isHostName('localhost')).toBe(true);
    expect(isHostName(`${'a'.repeat(63)}.example`)).toBe(true);
    expect(isHostName(`${'a'.repeat(64)}.example`)).toBe(false);
    expect(isHostName(`${'a.'.repeat(127)}ab`)).toBe(false);
    expect(isHostName('a..example')).toBe(false);
    expect(isHostName('')).toBe(false);
    expect(isHostName(null)).toBe(false);
  });
});
