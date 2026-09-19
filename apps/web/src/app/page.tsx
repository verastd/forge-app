import Link from 'next/link';

const REPO_URL = 'https://github.com/verastd/forge-app';

/*
 * The map plate: one city block in plan view, tilted into isometric by CSS.
 * Gold lots are built, dashed gold lots are up for grabs, the cyan lot is the
 * one being worked on right now. Decorative, so hidden from assistive tech.
 */
const LOTS: ReadonlyArray<{ x: number; y: number; w: number; h: number; kind?: 'owned' | 'listed' | 'live' }> = [
  // north-west block
  { x: 24, y: 24, w: 52, h: 40, kind: 'owned' },
  { x: 82, y: 24, w: 36, h: 40 },
  { x: 24, y: 70, w: 36, h: 48 },
  { x: 66, y: 70, w: 52, h: 48, kind: 'listed' },
  // north-east block
  { x: 142, y: 24, w: 44, h: 56 },
  { x: 192, y: 24, w: 44, h: 26, kind: 'owned' },
  { x: 192, y: 56, w: 44, h: 24 },
  { x: 142, y: 86, w: 94, h: 32, kind: 'owned' },
  // south-west block
  { x: 24, y: 142, w: 94, h: 30 },
  { x: 24, y: 178, w: 44, h: 58, kind: 'live' },
  { x: 74, y: 178, w: 44, h: 58 },
  // south-east block
  { x: 142, y: 142, w: 40, h: 40, kind: 'listed' },
  { x: 188, y: 142, w: 48, h: 40 },
  { x: 142, y: 188, w: 94, h: 48, kind: 'owned' },
];

function lotClass(kind?: 'owned' | 'listed' | 'live'): string {
  return kind === undefined ? 'map-lot' : `map-lot map-lot-${kind}`;
}

function CityBlock() {
  return (
    <div className="hero-map" aria-hidden="true">
      <svg viewBox="0 0 260 260" focusable="false">
        <rect className="map-ground" x="6" y="6" width="248" height="248" rx="14" />
        <path className="map-avenue" d="M130 6V254M6 130H254" />
        <path className="map-lane" d="M130 6V254M6 130H254" />
        <path className="map-street" d="M6 6 254 254" />
        {LOTS.map((lot) => (
          <rect
            key={`${lot.x}-${lot.y}`}
            className={lotClass(lot.kind)}
            x={lot.x}
            y={lot.y}
            width={lot.w}
            height={lot.h}
            rx="4"
          />
        ))}
        <circle className="map-pin" cx="46" cy="207" r="18" />
      </svg>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="page">
      <section className="hero">
        <div className="hero-copy">
          <p className="hero-eyebrow">Beta · made for Upland players</p>
          <p className="hero-mark">
            FORG<span className="hero-mark-accent">E</span>
          </p>
          <p className="hero-pitch">
            The community brings the intelligence and pays for the tokens. The repo brings the tasks
            and the gauntlet. The core team brings final judgment.
            <span className="hero-kicker">Nobody has to trust anybody.</span>
          </p>
          <p className="hero-sub">
            A live beta app that its own users help build — with the coding agents they already pay
            for.
          </p>
          <div className="row hero-actions">
            <Link href="/contribute" className="btn btn-primary btn-lg">
              Find a task
            </Link>
            <Link href="/history" className="btn btn-ghost btn-lg">
              See your history
            </Link>
          </div>
        </div>
        <CityBlock />
      </section>

      <section className="grid-3">
        <Link href="/history" className="card card-link">
          <span className="card-kicker">01 · Ledger</span>
          <h2 className="card-title">Your history</h2>
          <p className="muted">
            Everything that has moved in your account, with a one-tap spreadsheet download.
          </p>
          <span className="card-go" aria-hidden="true">
            Open ledger →
          </span>
        </Link>

        <Link href="/contribute" className="card card-link">
          <span className="card-kicker">02 · Build</span>
          <h2 className="card-title">Help build FORGE</h2>
          <p className="muted">
            Pick something the app needs, hand it to your agent, watch it ship. No coding required
            from you.
          </p>
          <span className="card-go" aria-hidden="true">
            Browse tasks →
          </span>
        </Link>

        <a href={REPO_URL} className="card card-link" target="_blank" rel="noreferrer noopener">
          <span className="card-kicker">03 · Source</span>
          <h2 className="card-title">The workshop</h2>
          <p className="muted">
            Every task, every check and every decision in the open, for the people who like to read
            the source.
          </p>
          <span className="card-go" aria-hidden="true">
            Read the source ↗
          </span>
        </a>
      </section>
    </main>
  );
}
