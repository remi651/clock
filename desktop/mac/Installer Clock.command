#!/bin/bash
set -euo pipefail
umask 077
trap 'echo; echo "Installation interrompue. Les temps existants sont conservés. Notez le message ci-dessus et contactez-moi."; read -r -p "Appuyez sur Entrée pour fermer. "' ERR
clock_source=$(cd "$(dirname "$0")/../.." && pwd)
clock_support="$HOME/Library/Application Support/Katra Clock"
clock_app="$HOME/Applications/Katra Clock.app"
if [ "$(uname -s)" != Darwin ]; then echo "Cet installateur est réservé à macOS."; exit 1; fi
clock_os=$(/usr/bin/sw_vers -productVersion)
clock_major=${clock_os%%.*}
clock_minor=${clock_os#*.}; clock_minor=${clock_minor%%.*}
if [ "$clock_major" -lt 13 ] || { [ "$clock_major" -eq 13 ] && [ "$clock_minor" -lt 5 ]; }; then
  echo "Clock nécessite macOS 13.5 ou supérieur. Votre version est $clock_os."
  read -r -p "Appuyez sur Entrée pour fermer. "
  exit 1
fi
case "$(uname -m)" in
  arm64) clock_arch=arm64; clock_sha=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a ;;
  x86_64) clock_arch=x64; clock_sha=d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52 ;;
  *) echo "Architecture Mac non prise en charge."; exit 1 ;;
esac
if [ -f "$clock_support/clock.pid" ]; then
  clock_old_pid=$(cat "$clock_support/clock.pid")
  case "$clock_old_pid" in
    ''|*[!0-9]*) ;;
    *)
      clock_old_command=$(/bin/ps -p "$clock_old_pid" -o command= 2>/dev/null || true)
      case "$clock_old_command" in
        *"$clock_support/app/desktop/main.mjs"*)
          echo "Quittez d’abord Katra Clock depuis le Dock, puis relancez cet installateur."
          read -r -p "Appuyez sur Entrée pour fermer. "
          exit 1 ;;
      esac ;;
  esac
fi
mkdir -p "$clock_support" "$HOME/Applications"
chmod 700 "$clock_support"
clock_temp=$(mktemp -d "$clock_support/install.XXXXXX")
trap 'rm -rf "$clock_temp"' EXIT
clock_version=v24.22.2
clock_runtime="$clock_support/runtime"
if [ ! -x "$clock_runtime/bin/node" ] || [ "$("$clock_runtime/bin/node" --version)" != "$clock_version" ]; then
  echo "1/4 · Téléchargement du moteur officiel Node.js ($clock_arch)…"
  clock_archive="node-$clock_version-darwin-$clock_arch.tar.gz"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --output "$clock_temp/$clock_archive" "https://nodejs.org/dist/$clock_version/$clock_archive"
  printf '%s  %s\n' "$clock_sha" "$clock_temp/$clock_archive" >"$clock_temp/SHA256.txt"
  /usr/bin/shasum -a 256 --check "$clock_temp/SHA256.txt"
  /usr/bin/tar -xzf "$clock_temp/$clock_archive" -C "$clock_temp"
  if [ -e "$clock_runtime" ]; then mv "$clock_runtime" "$clock_support/runtime-previous-$(date +%Y%m%d-%H%M%S)-$$"; fi
  mv "$clock_temp/node-$clock_version-darwin-$clock_arch" "$clock_runtime"
fi
echo "2/4 · Préparation de Clock et du Trousseau macOS…"
mkdir "$clock_temp/app"
for clock_file in package.json package-lock.json server.js; do cp "$clock_source/$clock_file" "$clock_temp/app/"; done
for clock_folder in desktop lib public; do cp -R "$clock_source/$clock_folder" "$clock_temp/app/"; done
export PATH="$clock_runtime/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_strict_ssl=true
"$clock_runtime/bin/npm" --prefix "$clock_temp/app" ci --omit=dev --ignore-scripts --no-fund --no-audit
"$clock_runtime/bin/node" --input-type=module -e 'import {createRequire} from "node:module"; const require=createRequire(process.argv[1]+"/package.json"); if(!require("@napi-rs/keyring").AsyncEntry) process.exit(1)' "$clock_temp/app"
echo "3/4 · Création de votre application Mac…"
/usr/bin/osacompile -o "$clock_temp/Katra Clock.app" "$clock_source/desktop/mac/Clock.applescript"
cp "$clock_source/desktop/mac/start.sh" "$clock_temp/Katra Clock.app/Contents/Resources/"
cp "$clock_source/desktop/mac/stop.sh" "$clock_temp/Katra Clock.app/Contents/Resources/"
clock_plist="$clock_temp/Katra Clock.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.studio-katra.clock.personal' "$clock_plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string com.studio-katra.clock.personal' "$clock_plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Katra Clock' "$clock_plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Add :CFBundleName string Katra Clock' "$clock_plist"
/usr/libexec/PlistBuddy -c 'Add :OSAAppletStayOpen bool true' "$clock_plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Set :OSAAppletStayOpen true' "$clock_plist"
/usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 13.5' "$clock_plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Set :LSMinimumSystemVersion 13.5' "$clock_plist"
# A local ad-hoc signature requires no Apple account. It is not notarization.
/usr/bin/codesign --force --sign - "$clock_temp/Katra Clock.app"
/usr/bin/codesign --verify --strict "$clock_temp/Katra Clock.app"
clock_stamp="$(date +%Y%m%d-%H%M%S)-$$"
if [ -d "$clock_support/app" ]; then mv "$clock_support/app" "$clock_support/app-previous-$clock_stamp"; fi
mv "$clock_temp/app" "$clock_support/app"
if [ -e "$clock_app" ]; then mv "$clock_app" "$HOME/Applications/Katra Clock-previous-$clock_stamp.app"; fi
mv "$clock_temp/Katra Clock.app" "$clock_app"
echo "4/4 · Clock est installé dans votre dossier personnel Applications."
echo "L’interface va s’ouvrir dans votre navigateur. Aucun hébergement n’est utilisé."
/usr/bin/open "$clock_app"
read -r -p "Appuyez sur Entrée pour fermer cette fenêtre d’installation. "
