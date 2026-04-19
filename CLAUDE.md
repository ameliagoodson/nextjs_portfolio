# Portfolio — Next.js Rebuild

**New repo:** https://github.com/ameliagoodson/nextjs_portfolio.git

Amelia Goodson's personal portfolio site. Migrating from a WordPress/Local by Flywheel setup to Next.js. The goal is a visually impressive, animation-rich portfolio that signals "serious React/Next.js developer" to hiring managers for mid-level roles.

**Quality bar:** The Shopify Editions sites (https://www.shopify.com/editions/winter2026 and https://www.shopify.com/editions/summer2025) are the benchmark for craft and visual ambition. That level of polish — layered 3D scenes, scroll-responsive animations, cinematic transitions — is what we're aiming for. Not a carbon copy, but the same tier of quality and uniqueness. Never settle for a standard template feel.

**Always use Context7 MCP (`resolve-library-id` → `query-docs`) before implementing anything involving a third-party library.** Training data may be stale — Tailwind v4, Next.js 16, GSAP 3, R3F, Framer Motion all have recent API changes.

Skills are auto-loaded from `.agents/skills/` — check that folder to see what's available.

## Stack Decisions

| Concern         | Decision                       | Reason                                                                       |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| Framework       | Next.js 16 (App Router)        | SEO via SSG, `next/image`, already using at work, career signalling          |
| Hosting         | Vercel                         | Replaces Hostinger, zero-config deploys on git push, free tier sufficient    |
| Content         | MDX + TypeScript data files    | No CMS needed — updates a few times/year, dev is comfortable editing files   |
| Database        | None                           | All content is static config                                                 |
| Styling         | Tailwind v4                    | CSS-first config (`@theme inline` in `globals.css`, no `tailwind.config.js`) |
| State           | Zustand                        | Lightweight, no boilerplate, sufficient for portfolio scope                  |
| Unit tests      | Vitest + React Testing Library | `npm test` — config in `vitest.config.ts`, setup in `vitest.setup.ts`        |
| E2e tests       | Playwright (Chromium)          | `npm run test:e2e` — tests in `e2e/`, config in `playwright.config.ts`       |
| Package manager | npm                            |                                                                              |

## Animation Stack

| Effect type                              | Tool                                   | Notes                                                                                                                      |
| ---------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Hero canvas (3D elements, particles)     | React Three Fiber (R3F)                | Port from existing vanilla Three.js hero. R3F integrates naturally with React/Next.js component model                      |
| Scroll-driven DOM animations             | GSAP ScrollTrigger                     | For effects where scroll position directly drives animation progress (scrub). NOT scroll hijacking — page scrolls normally |
| Simple scroll-reveal (one-time triggers) | CSS transitions + IntersectionObserver | For staggered text reveals, element fade-ins on entry                                                                      |
| Page transitions                         | Framer Motion                          | Between route changes                                                                                                      |

**Important:** All components using animation libraries or browser APIs need `"use client"` at the top. Three.js/R3F hero must use `next/dynamic` with `ssr: false`.

## Quality Bar — Confirmed Achievable Effects

The following effects were reverse-engineered from Shopify Editions sites during planning. They are not a committed feature list — they are examples of what this stack can do, used to establish the quality level we're building toward. Specific animations for each section are TBD and should be discussed before implementation.

- **Staggered text reveal on scroll** — text split into spans, each with a staggered CSS transition delay, triggered by IntersectionObserver. Plays once on entry.
- **Scroll-scrubbed image separation** — two images start overlapping, translate apart as scroll progress increases. GSAP ScrollTrigger with scrub.
- **Layered parallax atmosphere** — background/foreground texture layers scrolling at different UV speeds in a Three.js fragment shader (clouds, stars). Infinite loop driven by `uTime` uniform.
- **Organic sway** — 2D plane assets (e.g. flowers, foliage) with vertex shader sine wave oscillation. More movement at top (petals) than bottom (stem). Pseudo-random offset per element.
- **Scroll-driven distortion transition** — hero scene rendered to texture, wave/displacement shader applied with intensity tied to scroll progress. Creates a "wavy pool" feel as the hero scrolls out.
- **Colourful nav entrance** — navigation items animate in with individual colours and wide spacing, then condense into a compact sidebar as scroll progresses. GSAP ScrollTrigger scrub.

## Hero Section (Confirmed)

- AI-generated looping video background — dark atmospheric botanical night scene (wildflowers swaying, clouds drifting, stars passing). To be generated with Runway Gen-4.5 using image-to-video from a reference still.
- Chrome/holographic script text overlay — port from existing Three.js WordPress theme (see reference below)
- R3F particle layer for twinkling stars on top of video
- Video: `autoplay muted loop playsInline`, compressed under 10MB

Additional hero scroll interactions (e.g. water distortion on scroll-out) are **not yet decided**. Discuss before implementing.

## Existing WordPress Project (Reference)

Located at sibling folder: `../wordpress_portfolio/app/public/wp-content/themes/ameliagoodson/`

GitHub repo: https://github.com/ameliagoodson/Portfolio
**Note:** The theme code is at `wp-content/themes/ameliagoodson/` — not the repo root. Don't look for JS/SCSS files at root level.

Key files to port:

- `assets/js/threejs-hero.js` — Three.js hero (chrome text effect, reverse-engineered from Shopify)
- `assets/js/chrome-text.js` — Chrome/holographic text shader
- `assets/scss/` — SCSS organised into settings/base/elements/parts layers

The WordPress theme used Vite as build tool and vanilla Three.js with the Kawase blur effect.

### Colour Palette (from `01-settings/_config.scss`)

```
background:  #18002d  (deep purple — primary background)
secondary:   #ff00c7  (hot pink/magenta — primary accent)
border:      #650d94  (mid purple)
accent:      #ff7f62  (coral/orange — button colour)
cyan:        #00eeff
green:       #91ff00
chartreuse:  #c7ff00
orange:      #fb2e00
pink:        #ff00c7
```

The palette is intentionally vivid and neon against the deep purple background. Carry this forward — the new site should feel like the same person designed it.

### Project ACF Fields (for reference when building MDX front matter)

Project metadata was stored in ACF under a `project` field group:

- `project_type` — e.g. "Client work"
- `project_company` + `project_link_company` — agency/client link
- `project_role` — e.g. "Developer"
- `project_tech_stack` — comma-separated string
- `project_features` — key features
- `project_duration`
- `project_link_live` — live site URL
- `project_image` + `show_project_image` — optional banner image

Project body content was WordPress post content (the WYSIWYG), not ACF fields.

## Content Architecture

**Project pages:** MDX files with front matter + flexible body

Front matter (consistent across all projects):

```yaml
---
title: ""
description: ""
projectType: ""
role: ""
techStack: []
liveUrl: ""
repoUrl: ""
---
```

Body: Free-form MDX. Drop in React components as needed:

- `<ImageGrid />` — multiple images
- `<Video />` — embedded video
- `<BeforeAfter before="" after="" />` — slider comparison
- More as needed

## Site Sections (Homepage)

Structure is confirmed, specific animations within each section are TBD:

1. **Hero** — full viewport, video + chrome text + particle stars
2. **Intro** — brief punchy tagline
3. **Work** — projects
4. **About** — short bio, experience summary
5. **Contact** — email + LinkedIn

Navigation: Top fixed bar. Animated entrance TBD — discuss before implementing.

## Aesthetic

- Retrowave / synthwave noir — dark, cinematic, atmospheric. NOT cold/terminal/hacker.
- Reference: Shopify Editions Summer '25 (palm trees, purple/pink sky, stars, chrome script)
- Botanical night scene: wildflowers, dramatic underlighting, moody teal/dark sky
- Chrome/holographic script typography for name in hero
- Deep purples, teals, hot pink accents — warm not clinical
- A rejected direction for reference: Stitch AI generated a "Kinetic Terminal" design (CRT scanlines, cipher text, 0px borders, hacker aesthetic) — this is explicitly not the vibe.

## Scroll Philosophy

No scroll hijacking. The page scrolls at normal speed always.

- **Scroll-triggered** = animation plays once when element enters viewport (CSS + IntersectionObserver)
- **Scroll-scrubbed** = animation progress is tied to scroll position (GSAP ScrollTrigger scrub). Page still scrolls normally — the animation just listens.

Both are fine. Neither hijacks scrolling.

## Career Context

- Targeting mid-level React/Next.js full-stack roles (~$25–35k pay raise from current level)
- Actively preparing for job hunt, aiming to apply within ~1 month of this conversation (April 2026)
- Current role: full-stack Next.js developer since Feb 2026
- Previous: WordPress/CMS work June 2022–June 2025, then React pivot
- Portfolio must signal genuine engineering skill, not CMS work
- WordPress not mentioned on LinkedIn or resume

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/) format: `type: short summary`.

Common types for this project: `feat`, `fix`, `style`, `refactor`, `test`, `chore`.

**Rules:**

- Max 5 bullet points in the body — focus on WHY, not what
- Atomic commits — one logical change per commit
- During a session, ask Claude to suggest commit points rather than committing everything at the end
- At the start of a new session, tell Claude what you're building so natural commit points can be flagged

**Examples:**

```
feat: add hero video background with overlay

- Video autoplay muted loop for atmospheric background
- Overlay tint uses bg/40 so text stays readable over dark footage

chore: set up Vitest with co-located test files

- Co-location keeps tests discoverable alongside the component they cover
- vitest.setup.ts at root keeps config flat and avoids a one-file test/ folder
```

## What We Are NOT Doing

- No WordPress (migrating away)
- No Hostinger (moving to Vercel)
- No CMS or headless CMS (content in MDX/TS files)
- No horizontal scrolling project sections
- No scroll hijacking
- No terminal/hacker aesthetic
- No database
