# Porting the Embers handoff into @forge/ui

Source bundle (read-only): `/tmp/claude-0/-home-user/b10a2370-16c2-5c47-a38b-1e29b7444baa/scratchpad/zip2/design_handoff_embers/`
(`components/<dir>/<Name>.jsx` is the reference implementation, `<Name>.d.ts` the prop
contract, `<Name>.prompt.md` the authoritative spec for states, ARIA and edge cases;
`<dir>/<dir>.card.html` shows every state; `DESIGN_SYSTEM.md` and `README.md` the rules).

Rules (from the handoff README, "About the design files" and "Fidelity"):

1. One `.tsx` per component at `src/<dir>/<Name>.tsx`, same exported names as the `.jsx`
   (e.g. `DataTable` and `Pager` both from `feedback/DataTable.tsx`). Props typed from the
   `.d.ts`; you may add `style?: CSSProperties` and extra optional props the `.jsx` already
   reads but the `.d.ts` forgot. Export prop types (`export interface XProps`).
2. Port the `.jsx` line for line. Keep every value: sizes, colors (CSS variables), timings,
   copy, state machines. Inline style objects stay inline style objects. Do not restyle,
   do not "improve" visuals.
3. Icons: `import { Icon } from '../core/Icon'` — names are typed (`IconName`). If the
   source uses a Lucide name not in `ICONS` (src/core/Icon.tsx), say so in your report;
   do not edit Icon.tsx yourself.
4. Fix only real bugs, and say which: e.g. a keyboard path that selects a locked option,
   a timer that is never cleared, a demo-only default. Every disabled control stays
   focusable with `aria-disabled` + a reason (never native `disabled`).
5. No `'use client'` needed per file (the package is consumed from client components).
   No new dependencies. No `any` (use `unknown` + narrowing). TypeScript strict,
   `noUncheckedIndexedAccess` is on. `import type` for type-only imports.
6. Tests: `src/<dir>/<dir>.test.tsx` (or one per component) with @testing-library/react
   + vitest (jsdom). Aim for >90% line coverage of your files: every state from the
   `.prompt.md` / card, keyboard paths, callbacks. Fake timers for timed behavior.
   Reference: `src/core/foundation.test.tsx`, `src/controls/shared-controls.test.tsx`.
7. Already ported (import, don't rewrite): core/Icon, Button, Spinner, Skeleton, Hint,
   Badge, AsyncButton, StatusBanner, StatusGlyph; controls/Check, Segment.
8. Do NOT edit files outside your assigned list, `src/index.ts`, package.json, or configs.
9. Check your work: `cd /home/user/forge-app/packages/ui && npx tsc --noEmit -p tsconfig.json`,
   `npx eslint src/<dir>`, `npx vitest run src/<dir> --coverage --coverage.include='src/<dir>/**'`.
   All must pass before you report.

Report back: the files written, exported names and prop types, any bugs you fixed (with the
reason), any Lucide names you needed, and the final coverage numbers for your files.
