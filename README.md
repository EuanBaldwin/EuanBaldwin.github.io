# euanbaldwin.github.io

My personal site. Plain HTML and CSS, no build step; GitHub Pages serves the repository as-is.

- `index.html` – the home page. The lidar animation is `assets/lidar.js` (add `?route` to the URL to see the rover's goals and plan).
- `portfolio/` – one page per job or project, plus the PDFs they link to.
- `assets/style.css` – all styling. Colours are CSS variables at the top; dark is the default and the toggle stores a light choice.
- `assets/img/` – images. Sources and licences are listed on `credits.html`.
- `tools/check.py` – checks links, asset versions, the sitemap, prev/next links and card labels.

To add a project: copy a page from `portfolio/`, edit the text and artefact, add a card to `index.html`, link it into the prev/next chain of its neighbours, and add the URL to `sitemap.xml`. When `style.css`, `site.js` or `lidar.js` changes, bump its `?v=` number on every page.

Before pushing:

```
python3 tools/check.py
```
