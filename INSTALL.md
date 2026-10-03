# Install - 3 steps

**1. Download and unzip** this folder anywhere (or `git clone` it into `ComfyUI/custom_nodes`).

**2. Double-click the installer**

- Windows: `install.bat`
- Mac: `install.command`

Answer its questions. It puts the nodes into your ComfyUI and installs the
**ComfyUI Bridge** panel into Photoshop.

**3. Restart ComfyUI and Photoshop.** In Photoshop open **Plugins > Geekatplay ComfyUI Bridge > ComfyUI Bridge**.

The dot at the top of the panel turns green when it can reach ComfyUI.

## Try it

1. Open any document in Photoshop.
2. In the panel open the **Workflows** tab. The built-in workflows are already in the list;
   **Settings > Browse ComfyUI...** adds ComfyUI's own templates.
3. Pick **Generate - Z-Image Turbo** (or Qwen, Flux, SDXL), type a prompt and press **Run**.
   The image arrives as a new layer.
4. Pick an **Edit - ...** workflow, select a layer or make a selection, type what to change
   and press **Run**.

No models yet? Pick **Photoshop Bridge - quick test** and press **Run**: it inverts the layer.

## If something is in the way

| Problem | Fix |
| --- | --- |
| Windows says "Windows protected your PC" | Click **More info > Run anyway**. |
| Mac says the installer can't be opened | Right-click `install.command` > **Open**, then **Open** again. |
| Mac double-click opens a text editor | In Terminal run `bash install.command` from this folder. |
| Installer can't install the panel | Open the Creative Cloud app, sign in, then double-click `build/GeekatplayComfyUIBridge.ccx`. |
| Panel says it cannot reach ComfyUI | Start ComfyUI. If it runs on another computer, enter its address in **Settings**. |
| Panel says the nodes are not installed | Restart ComfyUI. |

More in the [README](README.md).
