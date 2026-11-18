#include <stdint.h>
#include <stdio.h>

#include "../mood_logic.h"

struct TestCase {
  const char *name;
  uint32_t good;
  uint32_t motto;
  DisplayState expected;
};

const char *displayStateName(DisplayState state) {
  switch (state) {
    case DISPLAY_GRAY:
      return "GRAY";
    case DISPLAY_GREEN:
      return "GREEN";
    case DISPLAY_YELLOW:
      return "YELLOW";
    case DISPLAY_RED:
      return "RED";
    default:
      return "ERROR";
  }
}

int main() {
  const TestCase cases[] = {
      {"issue case 8/12", 8, 12, DISPLAY_YELLOW},
      {"issue case 13/7", 13, 7, DISPLAY_GREEN},
      {"issue case 7/13", 7, 13, DISPLAY_RED},
      {"issue case 2/1", 2, 1, DISPLAY_GRAY},
      {"zero counts", 0, 0, DISPLAY_GRAY},
      {"total four", 2, 2, DISPLAY_GRAY},
      {"total five", 3, 2, DISPLAY_YELLOW},
      {"good rate 39 percent", 39, 61, DISPLAY_RED},
      {"good rate 40 percent", 40, 60, DISPLAY_YELLOW},
      {"good rate 64 percent", 64, 36, DISPLAY_YELLOW},
      {"good rate 65 percent", 65, 35, DISPLAY_GREEN},
  };

  int failures = 0;
  const size_t caseCount = sizeof(cases) / sizeof(cases[0]);
  for (size_t index = 0; index < caseCount; ++index) {
    const TestCase &test = cases[index];
    const DisplayState actual =
        evaluateDisplayState(test.good, test.motto);
    const bool passed = actual == test.expected;
    printf("%s: %s (good=%u motto=%u expected=%s actual=%s)\n",
           passed ? "PASS" : "FAIL", test.name, test.good, test.motto,
           displayStateName(test.expected), displayStateName(actual));
    if (!passed) ++failures;
  }

  printf("%zu tests, %d failures\n", caseCount, failures);
  return failures == 0 ? 0 : 1;
}
