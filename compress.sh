#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: ./compress INPUT_DIR OUTPUT_DIR" >&2
  exit 1
fi

input=$(realpath -- "$1")
[[ -d "$input" ]] || { echo "Input must be a directory" >&2; exit 1; }

mkdir -p -- "$2"
output=$(realpath -- "$2")

if [[ "$output" == "$input" || "$output" == "$input/"* ]]; then
  echo "Output directory must not be inside the input directory" >&2
  exit 1
fi

name=$(basename -- "$input")
archive="$output/${name}_$(date +%Y%m%d_%H%M%S).7z"

(
  cd -- "$input"
  7z a -t7z -mx=1 -mmt=1 "$archive" .
)

echo "Created: $archive"
