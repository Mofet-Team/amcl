#!/bin/sh
# Build, package and install this extension into VS Code.
# usage: npm run install-local [-- <profile>]   e.g. npm run install-local -- work
set -e
cd "$(dirname "$0")/.."
npx vsce package --out dist/amcl.vsix
if [ -n "$1" ]; then
  code --install-extension dist/amcl.vsix --force --profile "$1"
else
  code --install-extension dist/amcl.vsix --force
fi
echo "Installed. Run 'Developer: Reload Window' in VS Code to load it."
