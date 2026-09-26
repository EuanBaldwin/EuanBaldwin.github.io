#!/usr/bin/env python3
"""Checks the site for the mistakes that creep in when 23 pages are edited by hand.

Run from anywhere before pushing:

    python3 tools/check.py

It prints each problem and exits with status 1 if there are any. Standard library only.

What it checks:
  - every local link, image, srcset entry, script and stylesheet points at a file that exists
  - style.css, site.js and lidar.js carry the same ?v= version on every page that uses them
  - the Content-Security-Policy hash on each page matches the inline theme script it allows
  - external links open in a new tab with rel="noopener"
  - canonical and og:url name the page's own address, og:image exists
  - sitemap.xml lists every page (except 404) and nothing that doesn't exist
  - prev/next pagers chain both ways, and the "Next" link at the foot matches the pager
  - a pager's title attribute matches the target page's heading
  - a project card shows the same title, text and label wherever it appears (home page and BSc page)
  - the year on a card matches a year on the project page it links to
"""
import base64
import hashlib
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = 'https://euanbaldwin.github.io/'
problems = []


def problem(page, msg):
    problems.append(f'{page}: {msg}')


def text(fragment):
    """Visible text of an HTML fragment, whitespace collapsed."""
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', fragment))).strip()


pages = sorted(p for p in ROOT.rglob('*.html') if '.git' not in p.parts and 'tools' not in p.parts)
source = {p: p.read_text(encoding='utf-8') for p in pages}
rel = lambda p: p.relative_to(ROOT).as_posix()

# ---- local references resolve ----
for p, s in source.items():
    refs = re.findall(r'\b(?:href|src)="([^"]+)"', s)
    for srcset in re.findall(r'\bsrcset="([^"]+)"', s):
        refs += [part.strip().split(' ')[0] for part in srcset.split(',')]
    for ref in refs:
        if re.match(r'^(https?:|mailto:|tel:|data:|#|javascript:)', ref) or ref.startswith('//'):
            continue
        path = ref.split('#')[0].split('?')[0]
        if not path:
            continue
        target = (ROOT / path.lstrip('/')) if path.startswith('/') else (p.parent / path)
        if target.is_dir():
            target = target / 'index.html'
        if not target.resolve().exists():
            problem(rel(p), f'broken reference "{ref}"')

# ---- asset versions agree across pages ----
for asset in ('style.css', 'site.js', 'lidar.js'):
    seen = {}
    for p, s in source.items():
        for v in re.findall(re.escape(asset) + r'\?v=(\d+)', s):
            seen.setdefault(v, []).append(rel(p))
        if re.search(re.escape(asset) + r'"', s):
            problem(rel(p), f'{asset} is linked without a ?v= version')
    if len(seen) > 1:
        detail = '; '.join(f'v{v} on {len(ps)} page(s), e.g. {ps[0]}' for v, ps in seen.items())
        problems.append(f'{asset}: versions differ across pages ({detail})')

# ---- the CSP hash matches the inline theme script ----
for p, s in source.items():
    csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', s)
    inline = [m for m in re.findall(r'<script>(.*?)</script>', s, re.S)]
    if not csp:
        problem(rel(p), 'no Content-Security-Policy meta tag')
        continue
    allowed = set(re.findall(r"'sha256-([^']+)'", csp.group(1)))
    for body in inline:
        digest = base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode()
        if digest not in allowed:
            problem(rel(p), f"inline script is not allowed by the CSP (its hash is 'sha256-{digest}')")

# ---- external links open in a new tab ----
for p, s in source.items():
    for tag in re.findall(r'<a\b[^>]*\bhref="https?://[^"]+"[^>]*>', s):
        href = re.search(r'href="([^"]+)"', tag).group(1)
        if href.startswith(SITE):
            continue
        if 'target="_blank"' not in tag or 'noopener' not in tag:
            problem(rel(p), f'external link without target="_blank" rel="noopener": {href}')

# ---- canonical, og:url, og:image ----
for p, s in source.items():
    if p.name == '404.html':
        continue
    want = SITE + ('' if rel(p) == 'index.html' else rel(p))
    for prop, pattern in (('canonical', r'<link rel="canonical" href="([^"]+)"'), ('og:url', r'<meta property="og:url" content="([^"]+)"')):
        m = re.search(pattern, s)
        if not m:
            problem(rel(p), f'no {prop}')
        elif m.group(1) != want:
            problem(rel(p), f'{prop} is {m.group(1)}, expected {want}')
    m = re.search(r'<meta property="og:image" content="([^"]+)"', s)
    if m and m.group(1).startswith(SITE) and not (ROOT / m.group(1)[len(SITE):]).exists():
        problem(rel(p), f'og:image file missing: {m.group(1)}')

# ---- sitemap ----
sitemap = ROOT / 'sitemap.xml'
if sitemap.exists():
    listed = set(re.findall(r'<loc>([^<]+)</loc>', sitemap.read_text()))
    for p in pages:
        if p.name == '404.html':
            continue
        url = SITE + ('' if rel(p) == 'index.html' else rel(p))
        if url not in listed:
            problem('sitemap.xml', f'missing {url}')
    for url in listed:
        path = url[len(SITE):] or 'index.html'
        if not (ROOT / path).exists():
            problem('sitemap.xml', f'lists a page that does not exist: {url}')
else:
    problems.append('sitemap.xml is missing')

# ---- pagers and the "Next" link at the foot ----
def heading(p):
    m = re.search(r'<h1[^>]*>(.*?)</h1>', source.get(p, ''), re.S)
    return text(m.group(1)) if m else None

pager = {}
for p, s in source.items():
    nav = re.search(r'<nav class="pager[^"]*"[^>]*>(.*?)</nav>', s, re.S)
    if not nav:
        continue
    links = dict((d, (href, title)) for href, title, d in re.findall(r'<a href="([^"]+)" title="([^"]+)">(?:← )?(prev|next)(?: →)?</a>', nav.group(1)))
    pager[p] = links
    for d, (href, title) in links.items():
        target = (p.parent / href).resolve()
        h = heading(target)
        if h is not None and html.unescape(title) != h:
            problem(rel(p), f'{d} link title "{html.unescape(title)}" does not match the heading of {href} ("{h}")')
    foot = re.search(r'<a class="next" href="([^"]+)">.*?<span class="title">(.*?)<span', s, re.S)
    if 'next' in links:
        if not foot:
            problem(rel(p), 'has a next page but no "Next" link at the foot')
        elif foot.group(1) != links['next'][0] or text(foot.group(2)) != html.unescape(links['next'][1]):
            problem(rel(p), f'"Next" link at the foot ({foot.group(1)}) does not match the pager ({links["next"][0]})')
    elif foot:
        problem(rel(p), '"Next" link at the foot but no next page in the pager')
for p, links in pager.items():
    if 'next' in links:
        q = (p.parent / links['next'][0]).resolve()
        back = pager.get(q, {}).get('prev')
        if not back or (q.parent / back[0]).resolve() != p.resolve():
            problem(rel(p), f'next is {links["next"][0]}, but that page\'s prev does not point back here')

# ---- cards say the same thing everywhere, and their year matches the page ----
cards = {}
for p, s in source.items():
    for href, body in re.findall(r'<a class="card[^"]*" href="([^"]+)"[^>]*>(.*?)</a>', s, re.S):
        if href.startswith('http'):
            continue
        target = (p.parent / href).resolve()
        t = re.search(r'<h[23]>(.*?)</h[23]>', body, re.S)
        d = re.search(r'<p>(.*?)</p>', body, re.S)
        w = re.search(r'<span class="when mono">(.*?)</span>', body, re.S)
        card = tuple(text(x.group(1)) if x else '' for x in (t, d, w))
        cards.setdefault(target, []).append((rel(p), card))
for target, seen in cards.items():
    project_cards = [(pg, c) for pg, c in seen if not re.search(r'\d{4} – (present|\d{2,4})', c[2])]   # work and degree tiles show date ranges, not labels
    variants = {c for _, c in project_cards}
    if len(variants) > 1:
        problem(rel(target), 'its card differs between pages: ' + ' | '.join(f'{pg}: {c}' for pg, c in project_cards))
    page_text = text(source.get(target, ''))
    for pg, (_, _, label) in project_cards:
        years = re.findall(r'\b(19|20)(\d{2})\b', label)
        for a, b in years:
            if a + b not in page_text:
                problem(pg, f'card for {rel(target)} says {a + b}, but that page never mentions {a + b}')

if problems:
    print(f'{len(problems)} problem(s):')
    for line in problems:
        print('  - ' + line)
    sys.exit(1)
print(f'All good: {len(pages)} pages checked.')
