#!/usr/bin/env bash
set -euo pipefail
 
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
MODELS_DIR="$SCRIPT_DIR/models"
REGISTRY_URL="https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records?_limit=500"
CDN="https://firefox-settings-attachments.cdn.mozilla.net"
 
# ── Language definitions ──
 
NON_EN_LANGS=(ar zh da nl fr de el he hi it ja ko no pl pt ro ru sr es sv th uk vi)
 
lang_name() {
  case "$1" in
    ar) echo "Arabic"     ;; zh) echo "Chinese"    ;; da) echo "Danish"     ;;
    nl) echo "Dutch"      ;; en) echo "English"    ;; fr) echo "French"     ;;
    de) echo "German"     ;; el) echo "Greek"      ;; he) echo "Hebrew"     ;;
    hi) echo "Hindi"      ;; it) echo "Italian"    ;; ja) echo "Japanese"   ;;
    ko) echo "Korean"     ;; no) echo "Norwegian"  ;; pl) echo "Polish"     ;;
    pt) echo "Portuguese" ;; ro) echo "Romanian"   ;; ru) echo "Russian"    ;;
    sr) echo "Serbian"    ;; es) echo "Spanish"    ;; sv) echo "Swedish"    ;;
    th) echo "Thai"       ;; uk) echo "Ukrainian"  ;; vi) echo "Vietnamese" ;;
    *)  echo "$1" ;;
  esac
}
 
berg_code() {
  case "$1" in
    ar) echo "ar"      ;; zh) echo "zh-Hans" ;; da) echo "da" ;;
    nl) echo "nl"      ;; en) echo "en"      ;; fr) echo "fr" ;;
    de) echo "de"      ;; el) echo "el"      ;; he) echo "he" ;;
    hi) echo "hi"      ;; it) echo "it"      ;; ja) echo "ja" ;;
    ko) echo "ko"      ;; no) echo "nb"      ;; pl) echo "pl" ;;
    pt) echo "pt"      ;; ro) echo "ro"      ;; ru) echo "ru" ;;
    sr) echo "sr"      ;; es) echo "es"      ;; sv) echo "sv" ;;
    th) echo "th"      ;; uk) echo "uk"      ;; vi) echo "vi" ;;
    *)  echo "$1" ;;
  esac
}
 
# ── Helpers ──
 
bold()   { printf "\033[1m%s\033[0m" "$1"; }
green()  { printf "\033[32m%s\033[0m" "$1"; }
yellow() { printf "\033[33m%s\033[0m" "$1"; }
red()    { printf "\033[31m%s\033[0m" "$1"; }
dim()    { printf "\033[2m%s\033[0m" "$1"; }
 
pair_is_complete() {
  local dir="$1"
  [[ -d "$dir" ]] && ls "$dir"/*.bin &>/dev/null && ls "$dir"/*.spm &>/dev/null
}
 
lang_status() {
  local lang="$1"
  local to_ok=false from_ok=false to_exists=false from_exists=false
 
  [[ -d "$MODELS_DIR/${lang}_en" ]] && to_exists=true
  [[ -d "$MODELS_DIR/en_${lang}" ]] && from_exists=true
  pair_is_complete "$MODELS_DIR/${lang}_en" && to_ok=true
  pair_is_complete "$MODELS_DIR/en_${lang}" && from_ok=true
 
  if $to_ok && $from_ok; then
    echo "ok"
  elif $to_exists || $from_exists; then
    echo "partial"
  else
    echo "none"
  fi
}
 
installed_langs() {
  local langs=()
  for lang in "${NON_EN_LANGS[@]}"; do
    local st
    st=$(lang_status "$lang")
    if [[ "$st" != "none" ]]; then
      langs+=("$lang")
    fi
  done
  echo "${langs[@]}"
}
 
write_installed_languages() {
  local langs=()
  for lang in "${NON_EN_LANGS[@]}"; do
    if [[ "$(lang_status "$lang")" == "ok" ]]; then
      langs+=("\"$lang\"")
    fi
  done
  if [[ ${#langs[@]} -eq 0 ]]; then
    json="[]"
  else
    json=$(IFS=,; echo "[${langs[*]}]")
  fi
  echo "$json" > "$SCRIPT_DIR/installed-languages.json"
}
 
download_pair() {
  local from="$1" to="$2" pair_key="${1}_${2}"
  local berg_from berg_to
  berg_from=$(berg_code "$from")
  berg_to=$(berg_code "$to")
  local remote_key="${berg_from}_${berg_to}"
  local pair_dir="$MODELS_DIR/$pair_key"
 
  mkdir -p "$pair_dir"
 
  local pair_code="${berg_from//\-/}${berg_to//\-/}"
 
  local files
  files=$(echo "$REGISTRY_DATA" | python3 -c "
import json, sys
data = json.load(sys.stdin)
best = {}
for r in data.get('data', []):
    if r.get('fromLang') != '$berg_from' or r.get('toLang') != '$berg_to':
        continue
    ver = r.get('version', '0')
    key = r.get('name', '')
    if key not in best or ver > best[key][1]:
        best[key] = (r, ver)
for name, (r, ver) in best.items():
    loc = r['attachment']['location']
    ft = r.get('fileType', 'vocab')
    if 'srcvocab' in name: ft = 'srcvocab'
    elif 'trgvocab' in name: ft = 'trgvocab'
    print(f'{ft}\t{name}\t$CDN/{loc}')
" 2>/dev/null)
 
  if [[ -z "$files" ]]; then
    echo "    ⚠ No models found for $pair_key, skipping"
    return 1
  fi
 
  local count=0 total
  total=$(echo "$files" | wc -l | tr -d ' ')
  local manifest="{"
 
  while IFS=$'\t' read -r ftype name url; do
    count=$((count + 1))
    local dest="$pair_dir/$name"
    if [[ -f "$dest" ]]; then
      printf "    [%d/%d] %s (cached)\n" "$count" "$total" "$name"
    else
      printf "    [%d/%d] %s ... " "$count" "$total" "$name"
      if curl -sfL -o "$dest" "$url"; then
        printf "$(green "done")\n"
      else
        printf "FAILED\n"
        rm -f "$dest"
        return 1
      fi
    fi
    [[ "$manifest" != "{" ]] && manifest="$manifest,"
    manifest="$manifest\"$ftype\":\"$name\""
  done <<< "$files"
 
  manifest="$manifest}"
  echo "$manifest" > "$pair_dir/manifest.json"
}
 
download_language() {
  local lang="$1"
  local name
  name=$(lang_name "$lang")
 
  echo ""
  echo "  $(bold "$name") ($lang)"
 
  local ok=true
  echo "  ↓ ${lang} → en"
  if ! download_pair "$lang" "en"; then
    ok=false
  fi
 
  echo "  ↓ en → ${lang}"
  if ! download_pair "en" "$lang"; then
    ok=false
  fi
 
  $ok
}
 
print_status() {
  local existing
  existing=$(installed_langs)
 
  if [[ -z "$existing" ]]; then
    echo "  No models installed."
  else
    echo "  Installed languages:"
    for lang in $existing; do
      local name
      name=$(lang_name "$lang")
      local st
      st=$(lang_status "$lang")
      if [[ "$st" == "ok" ]]; then
        local to_size from_size
        to_size=$(du -sh "$MODELS_DIR/${lang}_en" 2>/dev/null | cut -f1 || echo "?")
        from_size=$(du -sh "$MODELS_DIR/en_${lang}" 2>/dev/null | cut -f1 || echo "?")
        printf "    $(green "✓") %-12s ↔ English  (%s + %s)\n" "$name" "$to_size" "$from_size"
      else
        printf "    $(yellow "!") %-12s ↔ English  $(yellow "(incomplete — run polyt add to repair)")\n" "$name"
      fi
    done
  fi
  echo ""
}
 
pick_languages() {
  echo ""
  echo "  Available languages:"
  echo ""
 
  local available=()
  for lang in "${NON_EN_LANGS[@]}"; do
    available+=("$lang")
  done
 
  local total=${#available[@]}
  local cols=4
  local rows=$(( (total + cols - 1) / cols ))
 
  local row col idx
  for row in $(seq 0 $(( rows - 1 ))); do
    for col in $(seq 0 $(( cols - 1 ))); do
      idx=$(( col * rows + row ))
      if (( idx < total )); then
        local lang="${available[$idx]}"
        local name
        name=$(lang_name "$lang")
        local marker="  "
        if [[ -d "$MODELS_DIR/${lang}_en" ]] && ls "$MODELS_DIR/${lang}_en"/*.bin &>/dev/null 2>&1; then
          marker="$(green "✓")"
        fi
        printf "    %s %2d) %-14s" "$marker" "$(( idx + 1 ))" "$name"
      fi
    done
    echo ""
  done
  echo ""
  echo "  Enter numbers separated by spaces, $(bold "all") for everything, or $(bold "q") to cancel:"
  printf "  > "
  read -r selection
 
  SELECTED_LANGS=()
 
  if [[ "$selection" == "q" || "$selection" == "Q" ]]; then
    return 1
  fi
 
  if [[ "$selection" == "all" || "$selection" == "ALL" ]]; then
    SELECTED_LANGS=("${NON_EN_LANGS[@]}")
    return 0
  fi
 
  for num in $selection; do
    if [[ "$num" =~ ^[0-9]+$ ]] && (( num >= 1 && num <= ${#available[@]} )); then
      SELECTED_LANGS+=("${available[$((num - 1))]}")
    else
      echo "  Skipping invalid selection: $num"
    fi
  done
 
  if [[ ${#SELECTED_LANGS[@]} -eq 0 ]]; then
    echo "  No languages selected."
    return 1
  fi
}
 
# ── Commands ──
 
cmd_init() {
  echo ""
  echo "$(bold "PolyTranslate — Initial Setup")"
  echo ""
 
  if [[ -d "$MODELS_DIR" ]] && ls "$MODELS_DIR"/*/*.bin &>/dev/null 2>&1; then
    echo "  Models directory already exists. Use $(bold "polyt add") to install more languages"
    echo "  or $(bold "polyt update") to refresh existing models."
    exit 1
  fi
 
  echo "  Select which languages to install (all translate to/from English)."
  echo "  Each language pair is ~20-50 MB."
 
  if ! pick_languages; then
    echo "  Setup cancelled."
    exit 0
  fi
 
  echo ""
  echo "  Fetching model registry..."
  REGISTRY_DATA=$(curl -sf "$REGISTRY_URL")
 
  local success=0 fail=0
  for lang in "${SELECTED_LANGS[@]}"; do
    if download_language "$lang"; then
      success=$((success + 1))
    else
      fail=$((fail + 1))
    fi
  done
 
  echo ""
  echo "  ────────────────────────────────"
  write_installed_languages
  echo "  $(green "Done!") $success languages installed. $fail failed."
  echo "  Reload the extension in chrome://extensions to use them."
  echo ""
}
 
cmd_add() {
  echo ""
  echo "$(bold "PolyTranslate — Add Languages")"
  echo ""
 
  print_status
 
  echo "  Select additional languages to install:"
 
  if ! pick_languages; then
    echo "  Cancelled."
    exit 0
  fi
 
  echo ""
  echo "  Fetching model registry..."
  REGISTRY_DATA=$(curl -sf "$REGISTRY_URL")
 
  local success=0 fail=0 skipped=0
  for lang in "${SELECTED_LANGS[@]}"; do
    local st
    st=$(lang_status "$lang")
    if [[ "$st" == "ok" ]]; then
      echo ""
      echo "  $(dim "$(lang_name "$lang") already installed, skipping (use update to refresh)")"
      skipped=$((skipped + 1))
    elif download_language "$lang"; then
      success=$((success + 1))
    else
      fail=$((fail + 1))
    fi
  done
 
  echo ""
  echo "  ────────────────────────────────"
  write_installed_languages
  echo "  $(green "Done!") $success added, $skipped already installed, $fail failed."
  echo "  Reload the extension in chrome://extensions."
  echo ""
}
 
cmd_update() {
  echo ""
  echo "$(bold "PolyTranslate — Update Models")"
  echo ""
 
  local existing
  existing=$(installed_langs)
 
  if [[ -z "$existing" ]]; then
    echo "  No models installed. Run $(bold "polyt init") first."
    exit 1
  fi
 
  echo "  This will re-download the latest models for all installed languages."
  printf "  Continue? [y/N] "
  read -r confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "  Cancelled."
    exit 0
  fi
 
  echo ""
  echo "  Fetching model registry..."
  REGISTRY_DATA=$(curl -sf "$REGISTRY_URL")
 
  for lang in $existing; do
    rm -f "$MODELS_DIR/${lang}_en"/*.bin "$MODELS_DIR/${lang}_en"/*.spm 2>/dev/null
    rm -f "$MODELS_DIR/en_${lang}"/*.bin "$MODELS_DIR/en_${lang}"/*.spm 2>/dev/null
  done
 
  local success=0 fail=0
  for lang in $existing; do
    if download_language "$lang"; then
      success=$((success + 1))
    else
      fail=$((fail + 1))
    fi
  done
 
  echo ""
  echo "  ────────────────────────────────"
  write_installed_languages
  echo "  $(green "Done!") $success languages updated. $fail failed."
  echo "  Reload the extension in chrome://extensions."
  echo ""
}
 
cmd_remove() {
  echo ""
  echo "$(bold "PolyTranslate — Remove Languages")"
  echo ""
 
  local existing
  existing=$(installed_langs)
 
  if [[ -z "$existing" ]]; then
    echo "  No models installed."
    exit 0
  fi
 
  echo "  Installed languages:"
  echo ""
 
  local i=1
  local removable=()
  for lang in $existing; do
    local name
    name=$(lang_name "$lang")
    printf "    %2d) %-12s\n" "$i" "$name"
    removable+=("$lang")
    i=$((i + 1))
  done
 
  echo ""
  echo "  Enter numbers separated by spaces, $(bold "all") to remove everything, or $(bold "q") to cancel:"
  printf "  > "
  read -r selection
 
  if [[ "$selection" == "q" || "$selection" == "Q" ]]; then
    echo "  Cancelled."
    exit 0
  fi
 
  local to_remove=()
 
  if [[ "$selection" == "all" || "$selection" == "ALL" ]]; then
    to_remove=("${removable[@]}")
  else
    for num in $selection; do
      if [[ "$num" =~ ^[0-9]+$ ]] && (( num >= 1 && num <= ${#removable[@]} )); then
        to_remove+=("${removable[$((num - 1))]}")
      fi
    done
  fi
 
  if [[ ${#to_remove[@]} -eq 0 ]]; then
    echo "  No languages selected."
    exit 0
  fi
 
  for lang in "${to_remove[@]}"; do
    local name
    name=$(lang_name "$lang")
    rm -rf "$MODELS_DIR/${lang}_en" "$MODELS_DIR/en_${lang}"
    echo "  Removed $(bold "$name")"
  done
 
  if [[ -d "$MODELS_DIR" ]] && [[ -z "$(ls -A "$MODELS_DIR" 2>/dev/null)" ]]; then
    rmdir "$MODELS_DIR"
  fi
 
  write_installed_languages
 
  echo ""
  echo "  $(green "Done!") ${#to_remove[@]} languages removed."
  echo "  Reload the extension in chrome://extensions."
  echo ""
}
 
cmd_status() {
  echo ""
  echo "$(bold "PolyTranslate — Installed Models")"
  echo ""
  print_status
}
 
cmd_help() {
  echo ""
  echo "$(bold "PolyTranslate Model Setup")"
  echo ""
  echo "  Usage: polyt <command>"
  echo ""
  echo "  Commands:"
  echo "    init     First-time setup — choose and download language models"
  echo "    add      Download additional language models"
  echo "    update   Re-download latest versions of installed models"
  echo "    remove   Remove installed language models"
  echo "    status   Show which models are installed"
  echo "    help     Show this message"
  echo ""
  echo "  Examples:"
  echo "    polyt init          # Interactive first-time setup"
  echo "    polyt add           # Add more languages later"
  echo "    polyt update        # Refresh all installed models"
  echo "    polyt remove        # Remove languages you don't need"
  echo ""
}
 
# ── Main ──
 
command="${1:-help}"
 
case "$command" in
  init)   cmd_init   ;;
  add)    cmd_add    ;;
  update) cmd_update ;;
  remove) cmd_remove ;;
  status) cmd_status ;;
  help)   cmd_help   ;;
  *)
    echo "Unknown command: $command"
    cmd_help
    exit 1
    ;;
esac