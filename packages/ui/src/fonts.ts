/**
 * Self-hosted Embers faces (DESIGN_SYSTEM.md: "Self-host both fonts in
 * production"): Work Sans 400/500/600/700 for UI text, Geist Mono 400/500/600
 * for every number, account and transaction id. Import once from the app's
 * root layout for the Embers surface: `import '@forge/ui/fonts'`.
 */
import '@fontsource/work-sans/400.css';
import '@fontsource/work-sans/500.css';
import '@fontsource/work-sans/600.css';
import '@fontsource/work-sans/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';

export const EMBERS_FONTS = ['Work Sans', 'Geist Mono'] as const;
