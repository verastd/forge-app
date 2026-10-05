import Link from 'next/link';

import { ForgeHero } from '../components/hero/ForgeHero';

const REPO_URL = 'https://github.com/verastd/forge-app';

export default function HomePage() {
  return (
    <main className="page">
      {/*
        The hero: the animated FORGE grid (components/hero) full bleed behind
        the pitch. The copy is the page's; the grid is background only.
      */}
      <ForgeHero>
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
          for, in the open on{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          .
        </p>
        <div className="row hero-actions">
          <Link href="/contribute" className="btn btn-primary btn-lg">
            Find a task
          </Link>
          <Link href="/apps" className="btn btn-ghost btn-lg">
            Enter the lobby
          </Link>
        </div>
      </ForgeHero>

      <section className="grid-3">
        <Link href="/contribute" className="card card-link">
          <span className="card-kicker">01 · Contribute</span>
          <h2 className="card-title">Help build FORGE</h2>
          <p className="muted">Find an open contribution and point your AI at it.</p>
          <span className="card-go" aria-hidden="true">
            Browse tasks →
          </span>
        </Link>

        <Link href="/propose" className="card card-link">
          <span className="card-kicker">02 · Propose</span>
          <h2 className="card-title">Bring an idea</h2>
          <p className="muted">Pitch it in plain English. The community decides by Robert's Rules.</p>
          <span className="card-go" aria-hidden="true">
            Make a proposal →
          </span>
        </Link>

        <Link href="/apps" className="card card-link">
          <span className="card-kicker">03 · Apps</span>
          <h2 className="card-title">Enter the lobby</h2>
          <p className="muted">Everything the community has built, on one wall.</p>
          <span className="card-go" aria-hidden="true">
            Enter the lobby →
          </span>
        </Link>
      </section>
    </main>
  );
}
