---
description: Conventions for the single-file SPA frontend
globs: src/static/**
---

# Frontend Conventions

## Single File, No Build Step

The frontend is a single `index.html` file with inline CSS and JavaScript.
No framework, no bundler, no external CDN dependencies.

## XSS Prevention

MUST escape all dynamic content with an `esc()` helper before inserting
into the DOM via innerHTML. Session content from scanned projects may contain HTML.
SHOULD use `.textContent` for plain text values where possible.

## Self-Contained

The dashboard MUST work as a single HTTP response with zero external requests.
SHOULD use inline SVG for icons. No CDN fonts or scripts.
