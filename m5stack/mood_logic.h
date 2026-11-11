#pragma once

#include <stdint.h>

enum DisplayState {
  DISPLAY_GRAY,
  DISPLAY_GREEN,
  DISPLAY_YELLOW,
  DISPLAY_RED,
  DISPLAY_ERROR
};

// Uses integer cross multiplication so boundary decisions do not depend on
// floating-point rounding. Counts are uint32_t, so scaling by 100 fits safely
// in uint64_t.
inline DisplayState evaluateDisplayState(uint32_t goodCount,
                                         uint32_t mottoCount) {
  const uint64_t total = (uint64_t)goodCount + mottoCount;
  if (total < 5) return DISPLAY_GRAY;

  const uint64_t scaledGood = (uint64_t)goodCount * 100ULL;
  if (scaledGood >= total * 65ULL) return DISPLAY_GREEN;
  if (scaledGood >= total * 40ULL) return DISPLAY_YELLOW;
  return DISPLAY_RED;
}
