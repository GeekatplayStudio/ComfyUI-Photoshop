# Privacy Policy - Geekatplay ComfyUI Bridge

Geekatplay Studio - Vladimir Chopine - https://www.geekatplay.com

Last updated: October 3, 2026

Geekatplay ComfyUI Bridge (the Photoshop panel and its ComfyUI nodes) does not collect,
store or send any personal data to Geekatplay Studio or to anyone else.

## What the panel sends, and where

The panel talks only to the ComfyUI server whose address you enter in its Settings
(`http://127.0.0.1:8188` - your own computer - by default). When you press **Send Layer**
or **Run**, it sends that server:

- the pixels of the selection or layers you chose,
- the prompt you typed and the settings of the workflow you picked.

The server runs the workflow and the panel downloads the resulting images from it. If you
enter the address of a ComfyUI on another computer, this data goes to that computer. The
panel makes no other network requests.

## What is stored

- **In Photoshop's plugin storage on your computer:** the server address, the workflows
  you added and the settings you changed. Nothing leaves your computer.
- **On the ComfyUI server:** the uploaded layers are saved as PNG files in ComfyUI's
  `input/photoshop` folder and the results in its `output` folder, like any other ComfyUI
  job. Delete them there whenever you like.

## No tracking

No analytics, telemetry, crash reports, advertising identifiers, accounts or cookies.

## Links

**Open the setup guide** opens this project's page on GitHub in your browser, and only
after you click it. GitHub's own privacy policy applies there.

## Contact

Questions about this policy: open an issue at
https://github.com/GeekatplayStudio/ComfyUI-Photoshop/issues or use the contact page at
https://www.geekatplay.com.
