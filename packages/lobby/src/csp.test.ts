import { describe, expect, it } from 'vitest';

import { cspWithFrameSrc, framedAppHeaderRules } from './csp.js';
import { APPS } from './registry.js';
import type { AppEntry } from './registry.js';

/** The site-wide policy next.config.mjs sends on every route today. */
const SITE_CSP = "frame-ancestors 'none'";

function framed(slug: string, route: string, col: number): AppEntry {
  return {
    slug,
    title: slug,
    description: slug,
    hosting: 'framed',
    route,
    slot: { col, row: 2 },
    media: { kind: 'generated' },
    lit: true,
  };
}

describe('cspWithFrameSrc', () => {
  it('adds frame-src to the site policy and keeps frame-ancestors', () => {
    expect(cspWithFrameSrc(SITE_CSP, 'https://cards.forgeapps.example')).toBe(
      "frame-ancestors 'none'; frame-src https://cards.forgeapps.example",
    );
  });

  it('replaces an existing frame-src in place and keeps every other directive intact, in order', () => {
    const base = "default-src 'self'; frame-src https://old.example 'self'; img-src * data:; frame-ancestors 'none'";
    expect(cspWithFrameSrc(base, 'https://new.example')).toBe(
      "default-src 'self'; frame-src https://new.example; img-src * data:; frame-ancestors 'none'",
    );
  });

  it('matches the directive name case-insensitively and drops repeats browsers would ignore anyway', () => {
    expect(cspWithFrameSrc("FRAME-SRC *; frame-ancestors 'none'; frame-src 'self'", 'https://a.example')).toBe(
      "frame-src https://a.example; frame-ancestors 'none'",
    );
    // frame-src-ish names are other directives and stay.
    expect(cspWithFrameSrc('frame-srcx a; child-src b', 'https://a.example')).toBe(
      'frame-srcx a; child-src b; frame-src https://a.example',
    );
  });

  it('tidies empty directives and works from an empty base', () => {
    expect(cspWithFrameSrc(" ; frame-ancestors   'none' ;; ", 'https://a.example')).toBe(
      "frame-ancestors   'none'; frame-src https://a.example",
    );
    expect(cspWithFrameSrc('', 'https://a.example')).toBe('frame-src https://a.example');
  });

  it('refuses anything but a bare https://host origin, so nothing can be injected', () => {
    for (const origin of [
      'https://a.example; script-src *',
      'https://a.example;script-src',
      "https://a.example 'unsafe-inline'",
      'https://a.example https://evil.example',
      'https://a.example,script-src *',
      'https://a.example\nscript-src *',
      'https://a.example\r\nSet-Cookie: x=1',
      'https://*.example',
      '*',
      'https:',
      'https://',
      "'self'",
      '"https://a.example"',
      'https://a.example/',
      'https://a.example/path',
      'https://a.example:8443',
      'https://user@a.example',
      'http://a.example',
      'HTTPS://A.EXAMPLE',
      'data:',
      '',
      ' https://a.example',
    ]) {
      expect(() => cspWithFrameSrc(SITE_CSP, origin)).toThrow(/not a bare https:\/\/host origin/);
    }
    expect(() => cspWithFrameSrc(SITE_CSP, undefined as unknown as string)).toThrow(/not a bare https:\/\/host origin/);
  });

  it('refuses a base policy it cannot extend safely', () => {
    for (const base of ["frame-ancestors 'none', script-src *", "frame-ancestors 'none'\r\nX-Evil: 1", "frame-ancestors\t'none'"]) {
      expect(() => cspWithFrameSrc(base, 'https://a.example')).toThrow(/one policy with no commas or control characters/);
    }
    expect(() => cspWithFrameSrc(null as unknown as string, 'https://a.example')).toThrow(/one policy/);
  });
});

describe('framedAppHeaderRules', () => {
  it('returns no rules for the shipped APPS: nothing is framed yet', () => {
    expect(framedAppHeaderRules(APPS, SITE_CSP)).toEqual([]);
  });

  it('returns one rule per framed app, keyed on /apps/<slug>, keeping the site policy', () => {
    const apps = [
      ...APPS,
      framed('cards', 'https://cards.forgeapps.example/play', 1),
      framed('maps', 'https://maps.forgeapps.example', 2),
    ];
    expect(framedAppHeaderRules(apps, SITE_CSP)).toEqual([
      {
        source: '/apps/cards',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; frame-src https://cards.forgeapps.example" },
        ],
      },
      {
        source: '/apps/maps',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; frame-src https://maps.forgeapps.example" },
        ],
      },
    ]);
  });

  it('refuses to build a rule from a bad slug or route rather than emit a broad or unchecked one', () => {
    expect(() => framedAppHeaderRules([framed(':path*', 'https://a.forgeapps.example', 1)], SITE_CSP)).toThrow(
      /is not a valid slug/,
    );
    expect(() => framedAppHeaderRules([framed('cards', 'https://a.forgeapps.example:444/', 1)], SITE_CSP)).toThrow(
      /must not name a port/,
    );
    expect(() => framedAppHeaderRules([framed('cards', 'http://a.forgeapps.example/', 1)], SITE_CSP)).toThrow(
      /https: URL/,
    );
  });
});
