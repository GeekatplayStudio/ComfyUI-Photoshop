# Publishing on the Creative Cloud Marketplace

Everything needed to list **Geekatplay ComfyUI Bridge** through
[Adobe Developer Distribution](https://developer.adobe.com/developer-distribution/).

| File | Use |
| --- | --- |
| `LISTING.md` | Text for every listing field, within Adobe's limits |
| `assets/icon-48.png`, `icon-96.png`, `icon-192.png` | Plugin icons |
| `assets/screenshot-1.png` ... `screenshot-5.png` | Listing screenshots, 1360 x 800 (the first is the main one) |
| `assets/publisher-logo-250.png` | Publisher logo, 250 x 250 |
| `source/` | Vector sources of the icon, the panel glyphs and the logo |
| `check_listing.py` | Checks the text lengths and image sizes |
| `../PRIVACY.md` | Privacy policy (linked from the listing) |

## Steps

1. **Publisher profile.** Sign in at Developer Distribution and create the profile:
   name *Geekatplay Studio*, website *https://www.geekatplay.com*, a short description and
   `assets/publisher-logo-250.png`.
2. **Create the listing.** *Create New Listing > Creative Cloud desktop plugin >
   Photoshop*, plugin type UXP. Copy the **plugin ID** the portal generates.
3. **Put the ID in the manifest.** Done for this listing: `photoshop/manifest.json` has the
   ID `8393516f`. Raise `version` there before uploading a new build. The installers read
   the ID from the manifest and carry the settings of a panel installed under the earlier
   ID (`com.geekatplay.photoshop-comfyui-bridge`) over to it.
4. **Package.** In the Adobe UXP Developer Tool: *Add Plugin* > `photoshop/manifest.json`,
   then the row's **...** menu > **Package**. This writes the `.ccx` file to upload.
   Running the installer also builds the same package as `build/GeekatplayComfyUIBridge.ccx`
   (and installs it, so you test exactly what you upload).
5. **Upload and fill in the listing.** Upload the `.ccx`, then copy the fields from
   `LISTING.md`, add the three icons, the five screenshots, the support email, the help and
   privacy URLs, *Free* as purchase method, and the trader information if the plugin is
   offered in the EU.
6. **Reviewer note.** Paste *Note for Adobe reviewers* from `LISTING.md`. It explains how
   to start ComfyUI and test without downloading models.
7. **Submit for review.** Adobe aims to answer within 10 business days.

Before submitting, run:

```bash
node --test "tests/*.test.js"
python distribution/check_listing.py
```

and check the privacy and help URLs open (they point at `main` on GitHub).

## Review points already covered

| Adobe review point | In this plugin |
| --- | --- |
| Custom icons, all sizes and themes | Own artwork; panel glyphs for light and dark themes; listing icons at 48, 96, 192 |
| No Adobe logos or product icons | None in the icons, logo or screenshots; the screenshots show the panel and its results only |
| No blank panel at launch | Without ComfyUI the panel shows the setup steps and a link to the guide |
| Progress for long operations | Queue position, step progress bar, "Reading the workflow...", "Loading the templates..." |
| Clear, actionable errors | Every error says what to do; **Copy message** copies it |
| Layout and scrolling | The panel scrolls; minimum size 240 x 320 |
| Third-party dependencies disclosed | ComfyUI and the nodes are named in the description and the reviewer note |
| Support and privacy | GitHub issues and the website; `PRIVACY.md` (no data collection) |
| Network permission | `"domains": "all"`, because the user enters the ComfyUI address; explained in the reviewer note |

## Decide before submitting

- **Support email.** The listing needs one that is shown to users.
- **Generated content.** Adobe's guidelines ask plugins that generate images to include
  content filtering. This panel runs the user's own ComfyUI and models and adds no filter
  of its own; the reviewer may ask about it.
- **Names.** The plugin name uses *ComfyUI*, the name of a third-party open-source project,
  to say what it connects to. Adobe's guidelines also restrict Adobe product names in
  plugin names; the listing name avoids them.
