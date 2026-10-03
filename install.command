#!/bin/bash
# Geekatplay Photoshop Bridge - macOS installer
# by Geekatplay Studio - Vladimir Chopine - https://www.geekatplay.com
#
# Double-click to copy the ComfyUI nodes into your ComfyUI folder and install the
# Photoshop panel through Adobe Creative Cloud.
#   ./install.command [ComfyUI folder]

PACK="$(cd "$(dirname "$0")" && pwd)"
PACK_NAME="ComfyUI-Geekatplay-Photoshop"
CCX="$PACK/build/GeekatplayComfyUIBridge.ccx"
AGENT="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

step() { printf '\n  [%s/3] %s\n' "$1" "$2"; }
ok() { printf '        OK  %s\n' "$1"; }
say() { printf '            %s\n' "$1"; }
warn() { printf '        !!  %s\n' "$1"; }

# Accepts the ComfyUI folder or custom_nodes itself.
custom_nodes() {
    if [ "$(basename "$1")" = "custom_nodes" ] && [ -d "$1" ]; then echo "$1"
    elif [ -d "$1/custom_nodes" ]; then echo "$1/custom_nodes"
    elif [ -d "$1/ComfyUI/custom_nodes" ]; then echo "$1/ComfyUI/custom_nodes"
    fi
}

install_nodes() {
    step 1 "ComfyUI nodes"
    if [ "$(basename "$(dirname "$PACK")")" = "custom_nodes" ]; then
        ok "Already in ComfyUI: $PACK"
        return
    fi
    local nodes=""
    if [ -n "$1" ]; then
        nodes="$(custom_nodes "$1")"
        [ -z "$nodes" ] && { warn "No custom_nodes folder found in $1."; return 1; }
    else
        for guess in "$HOME/Documents/ComfyUI" "$HOME/ComfyUI" "$HOME/Desktop/ComfyUI"; do
            nodes="$(custom_nodes "$guess")"
            if [ -n "$nodes" ]; then
                read -r -p "            Found ComfyUI at $(dirname "$nodes"). Install there? [Y/n] " answer
                case "$answer" in [nN]*) nodes="" ;; esac
                break
            fi
        done
        if [ -z "$nodes" ]; then
            say "Pick your ComfyUI folder in the window that opens."
            say "Press Cancel if ComfyUI runs on another computer."
            local picked
            picked="$(osascript -e 'POSIX path of (choose folder with prompt "Select your ComfyUI folder (the one that contains custom_nodes)")' 2>/dev/null)"
            if [ -n "$picked" ]; then
                nodes="$(custom_nodes "${picked%/}")"
                [ -z "$nodes" ] && warn "There is no custom_nodes folder in $picked."
            fi
        fi
    fi
    if [ -z "$nodes" ]; then
        warn "Skipped. On the ComfyUI computer, put this folder in ComfyUI/custom_nodes"
        say "(or install it with ComfyUI-Manager or git clone)."
        return
    fi
    local target="$nodes/$PACK_NAME"
    mkdir -p "$target"
    rsync -a --exclude .git --exclude __pycache__ --exclude build --exclude .DS_Store "$PACK/" "$target/" || { warn "Copying to $target failed."; return 1; }
    ok "Copied to $target"
    say "Restart ComfyUI to load the nodes."
}

build_plugin() {
    step 2 "Photoshop panel package"
    mkdir -p "$(dirname "$CCX")"
    rm -f "$CCX"
    (cd "$PACK/photoshop" && zip -qrX "$CCX" . -x ".*" -x "*/.*") || { warn "Could not build $CCX."; return 1; }
    ok "Built $CCX"
}

manual_steps() {
    say "Install the panel by hand:"
    say "  1. Open the Adobe Creative Cloud app and sign in."
    say "  2. Double-click build/GeekatplayComfyUIBridge.ccx and confirm Install."
    say "  3. Restart Photoshop and open Plugins > Geekatplay ComfyUI Bridge."
    say "No Creative Cloud app? Use the Adobe UXP Developer Tool: Add Plugin,"
    say "pick photoshop/manifest.json in this folder, then Load."
    open -R "$CCX"
}

install_plugin() {
    step 3 "Install the panel in Photoshop"
    if [ ! -x "$AGENT" ]; then
        warn "Adobe Creative Cloud's plugin installer was not found."
        manual_steps
        return
    fi
    local output
    # An earlier version stays registered next to the new one unless it is removed first.
    "$AGENT" --remove "Geekatplay ComfyUI Bridge" >/dev/null 2>&1
    if output="$("$AGENT" --install "$CCX" 2>&1)"; then
        ok "Installed the ComfyUI Bridge panel."
        say "Open Plugins > Geekatplay ComfyUI Bridge in Photoshop (restart Photoshop if it is not there yet)."
    else
        warn "Creative Cloud could not install the panel:"
        say "$output"
        manual_steps
    fi
}

printf '\n  Geekatplay Photoshop Bridge - installer\n  Geekatplay Studio - www.geekatplay.com\n'
if install_nodes "$1" && build_plugin; then
    install_plugin
    printf '\n  Done. Next:\n'
    say "1. Start or restart ComfyUI."
    say "2. In Photoshop open Plugins > Geekatplay ComfyUI Bridge > ComfyUI Bridge."
    say "3. ComfyUI on another computer? Enter its address in the panel's Settings tab."
else
    printf '\n'
    warn "Installation stopped."
fi
printf '\n'
read -r -p "  Press Return to close " _
