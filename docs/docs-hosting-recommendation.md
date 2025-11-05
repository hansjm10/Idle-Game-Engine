---
sidebar_position: 999
---

# Documentation Hosting Recommendation

## Context

We need to host the Idle Engine documentation publicly for contributors, developers, and users. The documentation is built using Docusaurus and generates a static site.

## Requirements

- Public accessibility
- HTTPS support
- Custom domain capability (future)
- Zero or low cost
- Automatic deployment from main branch
- Preview deployments for pull requests (optional but desirable)

## Options Evaluated

### Option 1: GitHub Pages

**Pros:**
- Native GitHub integration
- Zero cost
- Simple setup with `gh-pages` branch or GitHub Actions
- Built-in HTTPS support
- Custom domain support via CNAME

**Cons:**
- No automatic PR previews (requires separate workflow)
- Build times count against Actions minutes
- Limited to static sites (already satisfied by Docusaurus)

**Implementation approach:**
- Use GitHub Actions to build docs on push to main
- Deploy to `gh-pages` branch using `peaceiris/actions-gh-pages@v4`
- Enable GitHub Pages in repository settings

### Option 2: Netlify

**Pros:**
- Automatic PR preview deployments
- Generous free tier for open source
- Fast CDN
- Build optimization and caching
- Deploy previews with unique URLs

**Cons:**
- External service dependency
- Requires account setup
- Build minutes limitations on free tier (300/month)

**Implementation approach:**
- Connect GitHub repository to Netlify
- Configure build command: `pnpm docs:build`
- Configure publish directory: `packages/docs/build`

### Option 3: Vercel

**Pros:**
- Excellent DX with automatic deployments
- PR preview deployments
- Fast edge network
- Good monorepo support
- Generous free tier for open source

**Cons:**
- External service dependency
- Requires account setup

**Implementation approach:**
- Connect GitHub repository to Vercel
- Create `vercel.json` configuration
- Configure build settings for monorepo

## Recommendation: GitHub Pages

**Rationale:**
- Zero external dependencies - keeps everything within GitHub
- Free forever with no service limitations
- Simple setup and maintenance
- Custom domain support for future use
- Sufficient for our current needs (public documentation hosting)
- Can migrate to Netlify/Vercel later if we need PR previews

**Implementation plan for production hosting:**

1. Create a new workflow `.github/workflows/docs-deploy.yml`
2. Trigger on push to main branch when docs change
3. Build the documentation site
4. Deploy to `gh-pages` branch using `peaceiris/actions-gh-pages@v4`
5. Enable GitHub Pages in repository settings
6. Optionally configure custom domain

**Next steps:**
- Create GitHub issue for implementing GitHub Pages deployment
- Decide on custom domain (if desired)
- Update repository settings after first deployment

## Future Considerations

If we later need PR preview deployments, we can:
- Migrate to Netlify or Vercel (preserving the GitHub Pages main deployment)
- Implement a custom preview deployment workflow using GitHub Pages environments
- Use a service like Cloudflare Pages which offers similar features
