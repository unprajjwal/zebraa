#!/usr/bin/env bash
set -euo pipefail

# Script to package the built macOS .app bundle into a plain .zip file (matching electron-builder's mac zip target).

BUNDLE_DIR=""
if [ -d "target/release/bundle/macos" ]; then
  BUNDLE_DIR="target/release/bundle/macos"
elif [ -d "target/release/bundle/osx" ]; then
  BUNDLE_DIR="target/release/bundle/osx"
elif [ -d "target/debug/bundle/macos" ]; then
  BUNDLE_DIR="target/debug/bundle/macos"
elif [ -d "target/debug/bundle/osx" ]; then
  BUNDLE_DIR="target/debug/bundle/osx"
fi

if [ -z "$BUNDLE_DIR" ] || [ ! -d "$BUNDLE_DIR/Zebraa.app" ]; then
  echo "Error: Zebraa.app not found in target/release/bundle/macos or osx."
  echo "Make sure you run 'tauri build' first."
  exit 1
fi

ZIP_PATH="$BUNDLE_DIR/Zebraa-macOS.zip"
echo "Packaging $BUNDLE_DIR/Zebraa.app into $ZIP_PATH..."
(cd "$BUNDLE_DIR" && zip -r -q Zebraa-macOS.zip Zebraa.app)

if [ -f "$ZIP_PATH" ]; then
  echo "Successfully created $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
else
  echo "Failed to create $ZIP_PATH"
  exit 1
fi
