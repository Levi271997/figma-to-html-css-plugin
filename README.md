# Digitalfeet Figma to HTML

A private Figma plugin that converts a selected frame or section into HTML and CSS. It can output an HTML file with a separate CSS file, or one self-contained HTML file. The single-file output is the input for the Elementor pipeline (not built yet).

Status: **draft, not yet tested in Figma.** The code has been syntax-checked and run against a mock of the Figma API in Node, but it has not been run against a real design.

## Setup (designers)

1. Clone this repo once: `git clone <repo-url>`
2. In the Figma desktop app, open any file, then go to **Plugins > Development > Import plugin from manifest…**
3. Select `manifest.json` from the cloned folder.
4. The plugin now appears under **Plugins > Development > Digitalfeet Figma to HTML**.

To get updates, run `git pull` in the folder, then close and reopen the plugin.

Development import works in the Figma desktop app only. It does not work in the browser.

## Use

1. Select one top-level frame (the page) or a section inside it. The plugin shows the selected layer's name and size.
2. Choose the output:
   - **HTML + CSS files**: `<name>.html` links to `<name>.css`. Keep both files in the same folder.
   - **Single HTML file**: the CSS is inside a `<style>` tag in the HTML.
3. Click **Convert selection**.
4. Check the result in the **Preview**, **HTML** and **CSS** tabs.
5. Click **Copy** to copy the HTML or CSS (the CSS tab copies the CSS), or **Download** to save the files.

Images are embedded as base64. The code tabs shorten them to `…(120 KB image)` so the code stays readable. Copy and Download keep the full data.

## Layer naming

Naming layers in the Digitalfeet way makes the output more useful:

- **Top-level children of the selected frame** become sections and get `data-section="<layer name>"`, e.g. `Hero/Split` or `FAQ/Accordion`. The Elementor step will match on these names.
- **Text layers** can force a tag by starting with `h1` to `h6` or `p`, e.g. `h2 Pricing`. Without a prefix, the tag is picked from the largest font size in the layer.
- **Frames, groups and components** whose name starts with `icon` or `svg`, e.g. `icon/arrow`, are exported as inline SVG.
- CSS class names come from the layer names, e.g. a layer called `Hero Card` gets a class like `hero-card-12`. Clear layer names give readable CSS.

## What converts

- Auto layout (direction, gap, padding, alignment, wrap) becomes flexbox. Grid auto layout becomes CSS grid.
- Frames without auto layout, and layers set to absolute position inside auto layout, use absolute positioning from their x/y. Rotation is kept.
- Groups inside auto layout are kept together as one box.
- Fills: solid colours, linear gradients (with their angle and stop positions), radial, angular and diamond gradients, and image fills. Several fills on one layer are stacked in the same order as in Figma.
- Strokes, including dashed strokes and inside, centre and outside alignment. Strokes do not move the layer's content, the same as in Figma. Different stroke weights per side become borders.
- Corner radii, opacity, clip content, and circles and ovals.
- Effects: drop and inner shadows, layer blur and background blur. Drop shadows on text become text shadows.
- Text: font family, size, weight, italic, line height, letter spacing, alignment, case, underline and strikethrough, colour, hug-width text and truncation. Text with mixed styles becomes spans, and links become `<a>` tags.
- Vectors, boolean shapes, stars, polygons, lines, arcs, and small layers that Figma marks as icons are exported as inline SVG.
- Fonts: each font family is loaded from Google Fonts with only the weights and styles that are used.

## Known limitations (draft)

- Image scale mode "Crop" is rendered as "Fill". Image fill opacity and blend modes are ignored.
- Radial and diamond gradients ignore rotation, and diamond gradients are drawn as radial.
- Text gradients and text strokes are ignored. Text uses its first solid colour.
- Masks are not converted.
- Fonts that are not on Google Fonts fall back to the system font.
- Images are embedded as base64, so large images make large files. Compress them in Figma first.
- Figma components and variants are converted by their current appearance, not as reusable components.
- The layout matches the frame at its design width. Constraints and responsive breakpoints are not converted.

## Network access

The plugin UI is allowed to reach `fonts.googleapis.com` and `fonts.gstatic.com` only, so the preview can show the design's fonts. Nothing about the design is sent anywhere.

## Access

This plugin is private. Only designers with the repo can import it. The license or login check planned for the server is **not in this draft**. Add it before the plugin goes to anyone outside the team.
