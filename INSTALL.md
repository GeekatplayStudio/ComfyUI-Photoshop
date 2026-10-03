# Install - 3 steps

You need ComfyUI, Photoshop 2024 or newer, and the Adobe **Creative Cloud** app signed in.

**1. Download and unzip** this folder anywhere (or `git clone` it into `ComfyUI/custom_nodes`).

**2. Double-click the installer**

- Windows: `install.bat`
- Mac: `install.command`

Answer its question about your ComfyUI folder (the one that contains `custom_nodes`).
It puts the nodes into your ComfyUI and installs the **ComfyUI Bridge** panel into
Photoshop. Wait for **Done**.

**3. Restart ComfyUI.** In Photoshop open **Plugins > Geekatplay ComfyUI Bridge > ComfyUI Bridge**
(restart Photoshop if it is not in the menu yet).

The dot at the top of the panel turns green when it can reach ComfyUI, and **Settings**
shows *13 built-in workflows*.

**Updating:** download the new version, run the installer again, restart ComfyUI and press
**Refresh** in the panel.

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
| Panel says the nodes are not installed or not loaded | Restart ComfyUI. |
| A workflow, model or template you just added does not show | Press **Refresh** at the top of the panel. |

More in the [README](README.md).
