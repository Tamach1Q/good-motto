#!/usr/bin/env bash

set -euo pipefail

test_build_dir="$(mktemp -d)"
trap 'rm -rf "$test_build_dir"' EXIT

c++ -std=c++11 -Wall -Wextra -Werror \
  "$(dirname "$0")/test_mood_logic.cpp" \
  -o "$test_build_dir/test_mood_logic"

"$test_build_dir/test_mood_logic"
