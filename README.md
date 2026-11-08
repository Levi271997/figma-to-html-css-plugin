# Figma to HTML/CSS

A Figma plugin that converts a selected frame or section into HTML and CSS. It can output an HTML file with a separate CSS file, or one self-contained HTML file.

Plain JavaScript with no build step: import the manifest and it runs.

Status: **early version.** The code has been tested against a mock of the Figma API, but not yet against a wide range of real designs. Bug reports and pull requests are welcome.

## Install

1. Clone this repo:
   ```
   git clone https://github.com/Levi271997/figma-to-html-css-plugin.git
   ```
2. In the Figma desktop app, open any file, then go to **Plugins > Development > Import plugin from manifest…**
3. Select `manifest.json` from the cloned folder.
4. The plugin now appears under **Plugins > Development**.

To update, run `git pull` in the folder, then close and reopen the plugin.

Importing a plugin from a manifest works in the Figma desktop app only, not in the browser.

## Use

1. Select one frame or section. The plugin shows the selected layer's name and size.
2. Choose the output:
   - **HTML + CSS files**: `<name>.html` links to `<name>.css`. Keep both files in the same folder.
   - **Single HTML file**: the CSS is inside a `<style>` tag in the HTML.
3. Click **Convert selection**.
4. Check the result in the **Preview**, **HTML** and **CSS** tabs.
5. Click **Copy** to copy the code (on the CSS tab it copies the CSS), or **Download** to save the files.

Images are embedded as base64. The code tabs shorten them to `…(120 KB image)` so the code stays readable. Copy and Download keep the full data.

## Layer naming tips

Layer names change the output:

- **Text layers** can force a tag by starting with `h1` to `h6` or `p`, e.g. `h2 Pricing`. Without a prefix, the tag is picked from the largest font size in the layer.
- **Frames, groups and components** whose name starts with `icon` or `svg`, e.g. `icon/arrow`, are exported as inline SVG.
- **CSS class names** come from layer names. A layer called `Hero Card` gets a class like `hero-card-12`, so clear layer names give readable CSS.
- **Direct children of the selected frame** get a `data-section="<layer name>"` attribute, which makes page sections easy to find in the output.

Every element also gets `data-figma-name` and `data-figma-type` attributes, so you can trace it back to its layer.

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

## Known limitations

- Image scale mode "Crop" is rendered as "Fill". Image fill opacity and blend modes are ignored.
- Radial and diamond gradients ignore rotation, and diamond gradients are drawn as radial.
- Text gradients and text strokes are ignored. Text uses its first solid colour.
- Masks are not converted.
- Fonts that are not on Google Fonts fall back to the system font.
- Images are embedded as base64, so large images make large files. Compress them in Figma first.
- Components and variants are converted by their current appearance, not as reusable components.
- The layout matches the frame at its design width. Constraints and responsive breakpoints are not converted.

## Network access

The plugin UI can reach `fonts.googleapis.com` and `fonts.gstatic.com` only, so the preview can show the design's fonts. Nothing about your design is sent anywhere.

## Files

| File | What it does |
| --- | --- |
| `manifest.json` | Plugin settings for Figma |
| `code.js` | Reads the selected layers and builds the HTML and CSS |
| `ui.html` | The plugin window: preview, code tabs, copy and download |
