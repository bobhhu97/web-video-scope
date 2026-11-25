#!/bin/bash
# Reads the extension's self-reported state from the active tab title.
# Requires no special permissions: the content script stamps document.title.
title=$(osascript -e 'tell application "Google Chrome" to get title of active tab of front window' 2>/dev/null)
echo "title: $title"
if [[ "$title" == *"[VS:"* ]]; then
  state=$(echo "$title" | sed -n 's/.*\[VS:\([^]]*\)\].*/\1/p')
  echo "extension state: $state"
else
  echo "extension state: NOT INJECTED (no marker in title)"
fi
