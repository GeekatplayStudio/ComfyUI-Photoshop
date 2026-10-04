# Listing text - Adobe Developer Distribution

Copy each block into the matching field of the Photoshop listing. Limits are Adobe's;
`distribution/check_listing.py` checks them.

## Public plugin name (45)

```text
Geekatplay ComfyUI Bridge
```

## Subtitle (30)

```text
Generate and edit with ComfyUI
```

## Description (5000)

```text
Run your ComfyUI workflows without leaving your document. Select a layer or make a selection, type what you want and press Run: the result comes back as a new layer, placed exactly over the area you sent. ComfyUI does the work - on your own computer or on a server you choose - and the panel takes care of everything in between.

READY TO GO
- 13 built-in workflows: Generate and Edit for Z-Image Turbo, Qwen Image 2.1, Flux.2 Klein 9B and SDXL, plus Remove Background, Depth Map (Marigold V2), Upscale 4x (SeedVR2), Inpaint transparent areas and a no-model quick test.
- Browse ComfyUI's own templates and the workflows you saved in ComfyUI, and add them with one click.
- Or add any workflow file - a regular save or an API export.

MADE FOR LAYERS
- Generate into the selection or the whole canvas, in its exact shape.
- Edit the selection, the selected layer or the whole canvas with a written instruction.
- Workflows with several image inputs get one source per input: the selection, the 1st, 2nd, 3rd... selected layer, the whole canvas or any named layer.
- Results land as smart objects, fitted over the source area. 8 and 16 bits per channel; layer transparency arrives in ComfyUI as a mask.

EVERY SETTING AT HAND
- The panel reads each workflow and shows its settings - model files, steps, seed, strength, size, upscale factor - as fields you can change. Changes are kept per workflow; Reset returns to the saved values.
- It finds which node receives the image and which the prompt by itself, and lets you choose when a workflow is ambiguous.
- Missing model files are listed with their download links before you run.

SMOOTH IN DAILY USE
- Queue position and sampler progress while ComfyUI works; Cancel at any time.
- Switching to a workflow that uses other models frees ComfyUI's memory first.
- Refresh reads new models, workflows and templates without restarting anything.
- Active Workflow mode: send a layer to the workflow open in ComfyUI's browser tab, run it there and get every result back as a layer.

REQUIREMENTS
- ComfyUI (free, open source) running on this computer or on another computer you can reach. It is a separate application and is not installed by this plugin.
- The free Geekatplay Photoshop Bridge nodes installed in ComfyUI - one click with the installer from the project page, or with ComfyUI-Manager.
- The models of the workflows you use (open models such as Z-Image, Qwen Image, Flux.2 Klein and SDXL; each workflow lists the files it needs).
- An NVIDIA, AMD or Apple Silicon GPU is recommended for ComfyUI; the panel itself has no hardware requirements.

PRIVACY
The panel talks only to the ComfyUI address you enter. No accounts, no telemetry, no data sent to Geekatplay Studio. The plugin is free.

Setup guide, documentation and support: https://github.com/GeekatplayStudio/ComfyUI-Photoshop
```

## Categories

Productivity; Automation (or the nearest categories offered for Photoshop).

## Tags (300)

```text
ComfyUI, image generation, image editing, workflow, layers, selection, inpainting, upscale, background removal, depth map, Qwen Image, Flux, SDXL, Z-Image, text to image, local, open source
```

## Purchase method

Free.

## Support email (1000)

Your support address (shown to users).

## Help URL

```text
https://github.com/GeekatplayStudio/ComfyUI-Photoshop#readme
```

## Privacy Policy URL

```text
https://github.com/GeekatplayStudio/ComfyUI-Photoshop/blob/main/PRIVACY.md
```

## Terms of Service URL

Optional. The project's MIT license can be linked:

```text
https://github.com/GeekatplayStudio/ComfyUI-Photoshop/blob/main/LICENSE
```

## Supported languages (1000)

```text
English
```

## Version details / release notes (1000)

```text
1.2.0
- Browse ComfyUI's templates and your saved ComfyUI workflows and add them with one click; Remove takes them off again.
- Workflows with several image inputs: choose a source for each one (selection, selected layer 1, 2, 3..., whole canvas or a named layer).
- Settings: every workflow's model files, steps, seed, strength, size and upscale options as editable fields, kept per workflow.
- Missing model files listed with their download links.
- Refresh button; the panel reconnects by itself and keeps its lists when ComfyUI restarts.
- New built-in workflows: Depth Map (Marigold V2) and Upscale 4x (SeedVR2 7B).
- Setup steps and a link to the guide when ComfyUI is not reachable.
- Run and Cancel sit right under the prompt.
```

## Note for Adobe reviewers (1000)

```text
The panel is a client for ComfyUI, a free open-source app (github.com/comfyanonymous/ComfyUI) that must run on the same or another computer. No account or credentials.

Test setup (Windows, about 10 min):
1. Download ComfyUI portable from its GitHub releases, unzip, start run_cpu.bat (or run_nvidia_gpu.bat).
2. Download github.com/GeekatplayStudio/ComfyUI-Photoshop as ZIP, run install.bat, pick the ComfyUI folder when asked. Restart ComfyUI.
3. In Photoshop open Plugins > Geekatplay ComfyUI Bridge > ComfyUI Bridge. The dot turns green.

Test without any model download: open a document, select a layer, Workflows tab > "Photoshop Bridge - quick test" > Run. The inverted layer comes back as a new layer.

Without ComfyUI running, the panel shows setup steps and a link to the guide. Network access "all" is needed because the user enters the ComfyUI address (localhost or a LAN/remote server).
```
