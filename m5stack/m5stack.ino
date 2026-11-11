#include <M5Unified.h>
#include <ArduinoJson.h>

// ============================================================
// GOOD / MOTTO Core2 - Issue #1 Phase 1 (offline mock)
//
// No Wi-Fi, backend, database, or secret is used in this phase.
// A/B switches the five required mock responses. C reloads one.
// The same JSON parser will be reused by the Phase 2 HTTPS provider.
// ============================================================

const char *DEVICE_PLACE_ID = "laundry";
const size_t MOCK_CASE_COUNT = 5;

struct PlaceCounts {
  String placeId;
  int periodDays;
  uint32_t goodCount;
  uint32_t mottoCount;
  String updatedAt;
};

struct FetchResult {
  bool ok;
  PlaceCounts counts;
  String errorCode;
};

enum DisplayState {
  DISPLAY_GRAY,
  DISPLAY_GREEN,
  DISPLAY_YELLOW,
  DISPLAY_RED,
  DISPLAY_ERROR
};

// Exact API-contract shape, with the five values required by Issue #1.
const char *const MOCK_JSON_CASES[MOCK_CASE_COUNT] = {
    R"json({"place_id":"laundry","period_days":7,"good_count":8,"motto_count":12,"updated_at":"2026-11-11T00:00:00Z"})json",
    R"json({"place_id":"laundry","period_days":7,"good_count":13,"motto_count":7,"updated_at":"2026-11-11T00:05:00Z"})json",
    R"json({"place_id":"laundry","period_days":7,"good_count":7,"motto_count":13,"updated_at":"2026-11-11T00:10:00Z"})json",
    R"json({"place_id":"laundry","period_days":7,"good_count":2,"motto_count":1,"updated_at":"2026-11-11T00:15:00Z"})json",
    R"json({"place_id":"laundry","period_days":7,"good_count":0,"motto_count":0,"updated_at":"2026-11-11T00:20:00Z"})json",
};

bool parseCountsJson(const String &json, PlaceCounts &out, String &errorCode) {
  JsonDocument document;
  DeserializationError error = deserializeJson(document, json);
  if (error) {
    errorCode = "INVALID_JSON";
    return false;
  }

  if (!document["place_id"].is<const char *>() ||
      !document["period_days"].is<int>() ||
      !document["good_count"].is<int64_t>() ||
      !document["motto_count"].is<int64_t>() ||
      !document["updated_at"].is<const char *>()) {
    errorCode = "MISSING_FIELD";
    return false;
  }

  int periodDays = document["period_days"].as<int>();
  int64_t good = document["good_count"].as<int64_t>();
  int64_t motto = document["motto_count"].as<int64_t>();
  const char *placeId = document["place_id"].as<const char *>();
  const char *updatedAt = document["updated_at"].as<const char *>();

  if (periodDays <= 0 || good < 0 || motto < 0 ||
      String(placeId) != DEVICE_PLACE_ID || String(updatedAt).length() == 0) {
    errorCode = "INVALID_VALUE";
    return false;
  }

  out.placeId = placeId;
  out.periodDays = periodDays;
  out.goodCount = (uint32_t)good;
  out.mottoCount = (uint32_t)motto;
  out.updatedAt = updatedAt;
  errorCode = "";
  return true;
}

class CountsProvider {
 public:
  virtual FetchResult fetch() = 0;
  virtual const char *name() const = 0;
  virtual ~CountsProvider() = default;
};

class MockCountsProvider : public CountsProvider {
 public:
  FetchResult fetch() override {
    FetchResult result;
    result.ok = parseCountsJson(MOCK_JSON_CASES[index_], result.counts,
                                result.errorCode);
    return result;
  }

  const char *name() const override { return "MOCK"; }

  void next() { index_ = (index_ + 1) % MOCK_CASE_COUNT; }

  void previous() {
    index_ = index_ == 0 ? MOCK_CASE_COUNT - 1 : index_ - 1;
  }

  size_t index() const { return index_; }

 private:
  size_t index_ = 0;
};

MockCountsProvider mockProvider;
CountsProvider *countsProvider = &mockProvider;

PlaceCounts currentCounts;
bool hasValidData = false;
String currentError = "";
DisplayState currentState = DISPLAY_ERROR;
int currentGoodPercent = 0;
int currentMottoPercent = 0;

M5Canvas canvas(&M5.Display);

uint16_t colorInk;
uint16_t colorMuted;
uint16_t colorWhite;
uint16_t colorGray;
uint16_t colorGraySoft;
uint16_t colorGreen;
uint16_t colorGreenSoft;
uint16_t colorYellow;
uint16_t colorYellowSoft;
uint16_t colorRed;
uint16_t colorRedSoft;
uint16_t colorGood;
uint16_t colorMotto;

DisplayState evaluateDisplayState(const PlaceCounts &counts) {
  uint64_t total = (uint64_t)counts.goodCount + counts.mottoCount;
  if (total < 5) return DISPLAY_GRAY;

  float goodRate = (float)counts.goodCount / (float)total;
  if (goodRate >= 0.65f) return DISPLAY_GREEN;
  if (goodRate >= 0.40f) return DISPLAY_YELLOW;
  return DISPLAY_RED;
}

void calculatePercentages(const PlaceCounts &counts, int &goodPercent,
                          int &mottoPercent) {
  uint64_t total = (uint64_t)counts.goodCount + counts.mottoCount;
  if (total == 0) {
    goodPercent = 0;
    mottoPercent = 0;
    return;
  }

  goodPercent = (int)(((uint64_t)counts.goodCount * 100ULL + total / 2) /
                      total);
  mottoPercent = 100 - goodPercent;
}

const char *stateName(DisplayState state) {
  switch (state) {
    case DISPLAY_GREEN:
      return "GOOD CONDITION";
    case DISPLAY_YELLOW:
      return "WATCHING";
    case DISPLAY_RED:
      return "NEEDS ATTENTION";
    case DISPLAY_GRAY:
      return "NOT ENOUGH DATA";
    default:
      return "DATA ERROR";
  }
}

const char *stateColorName(DisplayState state) {
  switch (state) {
    case DISPLAY_GREEN:
      return "GREEN";
    case DISPLAY_YELLOW:
      return "YELLOW";
    case DISPLAY_RED:
      return "RED";
    case DISPLAY_GRAY:
      return "GRAY";
    default:
      return "ERROR";
  }
}

uint16_t stateAccent(DisplayState state) {
  switch (state) {
    case DISPLAY_GREEN:
      return colorGreen;
    case DISPLAY_YELLOW:
      return colorYellow;
    case DISPLAY_RED:
      return colorRed;
    case DISPLAY_GRAY:
      return colorGray;
    default:
      return colorRed;
  }
}

uint16_t stateBackground(DisplayState state) {
  switch (state) {
    case DISPLAY_GREEN:
      return colorGreenSoft;
    case DISPLAY_YELLOW:
      return colorYellowSoft;
    case DISPLAY_RED:
      return colorRedSoft;
    case DISPLAY_GRAY:
      return colorGraySoft;
    default:
      return colorRedSoft;
  }
}

void loadCurrentCase() {
  FetchResult result = countsProvider->fetch();
  if (!result.ok) {
    hasValidData = false;
    currentError = result.errorCode;
    currentState = DISPLAY_ERROR;
    Serial.printf("Provider error: %s\n", currentError.c_str());
    return;
  }

  currentCounts = result.counts;
  hasValidData = true;
  currentError = "";
  currentState = evaluateDisplayState(currentCounts);
  calculatePercentages(currentCounts, currentGoodPercent, currentMottoPercent);

  Serial.printf("MOCK %u/%u: good=%lu motto=%lu -> %s\n",
                (unsigned)(mockProvider.index() + 1),
                (unsigned)MOCK_CASE_COUNT,
                (unsigned long)currentCounts.goodCount,
                (unsigned long)currentCounts.mottoCount,
                stateColorName(currentState));
}

void drawThickLine(int x0, int y0, int x1, int y1, uint16_t color) {
  canvas.drawLine(x0, y0, x1, y1, color);
  canvas.drawLine(x0 + 1, y0, x1 + 1, y1, color);
  canvas.drawLine(x0, y0 + 1, x1, y1 + 1, color);
}

void drawWasherIcon(int x, int y) {
  canvas.drawRoundRect(x, y, 40, 52, 5, colorInk);
  canvas.drawFastHLine(x + 4, y + 14, 32, colorInk);
  canvas.fillCircle(x + 9, y + 7, 2, colorInk);
  canvas.fillCircle(x + 17, y + 7, 2, colorInk);
  canvas.fillCircle(x + 25, y + 7, 2, colorInk);
  canvas.drawCircle(x + 20, y + 34, 12, colorInk);
  canvas.drawCircle(x + 20, y + 34, 8, colorInk);
  canvas.drawLine(x + 14, y + 33, x + 19, y + 37, colorInk);
  canvas.drawLine(x + 19, y + 37, x + 26, y + 31, colorInk);
}

void drawFace(int centerX, int centerY, DisplayState state, uint16_t accent,
              uint16_t background) {
  canvas.fillCircle(centerX, centerY, 43, colorWhite);
  canvas.fillCircle(centerX, centerY, 39, background);
  canvas.fillCircle(centerX - 14, centerY - 8, 5, accent);
  canvas.fillCircle(centerX + 14, centerY - 8, 5, accent);

  if (state == DISPLAY_GREEN) {
    drawThickLine(centerX - 16, centerY + 9, centerX - 8, centerY + 17,
                  accent);
    drawThickLine(centerX - 8, centerY + 17, centerX + 8, centerY + 17,
                  accent);
    drawThickLine(centerX + 8, centerY + 17, centerX + 16, centerY + 9,
                  accent);
  } else if (state == DISPLAY_RED) {
    drawThickLine(centerX - 16, centerY + 19, centerX - 8, centerY + 11,
                  accent);
    drawThickLine(centerX - 8, centerY + 11, centerX + 8, centerY + 11,
                  accent);
    drawThickLine(centerX + 8, centerY + 11, centerX + 16, centerY + 19,
                  accent);
  } else {
    drawThickLine(centerX - 15, centerY + 14, centerX + 15,
                  centerY + 14, accent);
  }
}

void drawRatioRing(int centerX, int centerY, int goodPercent,
                   DisplayState state) {
  const int outerRadius = 62;
  const int innerRadius = 48;
  int goodDegrees = goodPercent * 360 / 100;
  bool enoughData = state != DISPLAY_GRAY && state != DISPLAY_ERROR;

  for (int degree = 0; degree < 360; ++degree) {
    float radians = (degree - 90) * PI / 180.0f;
    int x0 = centerX + (int)(cosf(radians) * innerRadius);
    int y0 = centerY + (int)(sinf(radians) * innerRadius);
    int x1 = centerX + (int)(cosf(radians) * outerRadius);
    int y1 = centerY + (int)(sinf(radians) * outerRadius);
    uint16_t segmentColor = colorGray;
    if (enoughData) {
      segmentColor = degree < goodDegrees ? colorGood : colorMotto;
    }
    canvas.drawLine(x0, y0, x1, y1, segmentColor);
  }

  drawFace(centerX, centerY, state, stateAccent(state),
           stateBackground(state));
}

void drawHeader(uint16_t background) {
  canvas.fillRoundRect(7, 7, 306, 61, 12, colorWhite);
  drawWasherIcon(13, 12);

  canvas.setTextDatum(TL_DATUM);
  canvas.setTextColor(colorInk, colorWhite);
  canvas.setTextSize(2);
  canvas.drawString("LAUNDRY", 62, 14);
  canvas.setTextColor(colorMuted, colorWhite);
  canvas.setTextSize(1);
  canvas.drawString("7-DAY MOOD", 63, 43);

  uint16_t accent = stateAccent(currentState);
  canvas.fillRoundRect(215, 16, 84, 22, 8, accent);
  canvas.setTextDatum(MC_DATUM);
  canvas.setTextColor(colorWhite, accent);
  canvas.setTextSize(1);
  String mockLabel = String(countsProvider->name()) + " " +
                     String(mockProvider.index() + 1) + "/" +
                     String(MOCK_CASE_COUNT);
  canvas.drawString(mockLabel, 257, 27);

  canvas.setTextColor(colorMuted, colorWhite);
  canvas.drawString("ISSUE #1 PHASE 1", 257, 51);
}

void drawSummary(uint16_t background) {
  uint16_t accent = stateAccent(currentState);
  canvas.setTextDatum(MC_DATUM);
  canvas.setTextColor(accent, background);
  canvas.setTextSize(1);
  if (currentState == DISPLAY_GREEN) {
    canvas.drawString("GOOD CONDITION", 233, 94);
  } else if (currentState == DISPLAY_YELLOW) {
    canvas.drawString("WATCHING", 233, 94);
  } else if (currentState == DISPLAY_RED) {
    canvas.drawString("NEEDS", 233, 88);
    canvas.drawString("ATTENTION", 233, 101);
  } else if (currentState == DISPLAY_GRAY) {
    canvas.drawString("NOT ENOUGH", 233, 88);
    canvas.drawString("DATA", 233, 101);
  } else {
    canvas.drawString("DATA ERROR", 233, 94);
  }

  canvas.fillRoundRect(158, 119, 151, 4, 2, accent);
  canvas.fillRoundRect(158, 135, 151, 61, 12, colorWhite);

  canvas.fillRoundRect(170, 145, 15, 15, 4, colorGood);
  canvas.fillRoundRect(170, 169, 15, 15, 4, colorMotto);
  canvas.setTextDatum(TL_DATUM);
  canvas.setTextColor(colorInk, colorWhite);
  canvas.setTextSize(1);
  canvas.drawString("GOOD", 194, 151);
  canvas.drawString("MOTTO", 194, 175);

  canvas.setTextDatum(MR_DATUM);
  canvas.setTextSize(2);
  if (currentState == DISPLAY_GRAY || currentState == DISPLAY_ERROR) {
    canvas.drawString("--", 297, 151);
    canvas.drawString("--", 297, 175);
  } else {
    canvas.drawString(String(currentGoodPercent) + "%", 297, 151);
    canvas.drawString(String(currentMottoPercent) + "%", 297, 175);
  }

  canvas.setTextDatum(MC_DATUM);
  canvas.setTextColor(accent, background);
  canvas.setTextSize(1);
  canvas.drawString(stateColorName(currentState), 233, 210);
}

void drawFooter(uint16_t background) {
  canvas.fillRoundRect(8, 218, 304, 18, 7, colorWhite);
  canvas.setTextDatum(MC_DATUM);
  canvas.setTextColor(colorInk, colorWhite);
  canvas.setTextSize(1);
  canvas.drawString("A PREV", 57, 227);
  canvas.drawString("B NEXT", 160, 227);
  canvas.drawString("C RELOAD", 263, 227);
}

void drawErrorScreen() {
  canvas.fillSprite(colorRedSoft);
  canvas.setTextDatum(MC_DATUM);
  canvas.setTextColor(colorRed, colorRedSoft);
  canvas.setTextSize(2);
  canvas.drawString("MOCK DATA ERROR", 160, 100);
  canvas.setTextSize(1);
  canvas.drawString(currentError, 160, 130);
  canvas.drawString("C: RETRY", 160, 168);
  canvas.pushSprite(0, 0);
}

void drawDashboard() {
  if (!hasValidData) {
    drawErrorScreen();
    return;
  }

  uint16_t background = stateBackground(currentState);
  canvas.fillSprite(background);
  drawHeader(background);
  drawRatioRing(78, 145, currentGoodPercent, currentState);
  drawSummary(background);
  drawFooter(background);
  canvas.pushSprite(0, 0);
}

void setup() {
  auto config = M5.config();
  M5.begin(config);
  Serial.begin(115200);
  M5.Display.setRotation(1);

  colorInk = M5.Display.color565(20, 28, 38);
  colorMuted = M5.Display.color565(113, 123, 136);
  colorWhite = M5.Display.color565(250, 251, 253);
  colorGray = M5.Display.color565(115, 124, 137);
  colorGraySoft = M5.Display.color565(226, 230, 235);
  colorGreen = M5.Display.color565(26, 153, 92);
  colorGreenSoft = M5.Display.color565(218, 244, 229);
  colorYellow = M5.Display.color565(216, 155, 0);
  colorYellowSoft = M5.Display.color565(255, 242, 190);
  colorRed = M5.Display.color565(211, 55, 65);
  colorRedSoft = M5.Display.color565(255, 224, 226);
  colorGood = M5.Display.color565(238, 35, 118);
  colorMotto = M5.Display.color565(25, 106, 220);

  canvas.setPsram(true);
  canvas.setColorDepth(16);
  if (canvas.createSprite(320, 240) == nullptr) {
    M5.Display.fillScreen(TFT_RED);
    M5.Display.setTextDatum(MC_DATUM);
    M5.Display.setTextColor(TFT_WHITE, TFT_RED);
    M5.Display.drawString("SCREEN BUFFER ERROR", 160, 120);
    while (true) M5.delay(1000);
  }

  loadCurrentCase();
  drawDashboard();
}

void loop() {
  M5.update();

  bool changed = false;
  if (M5.BtnA.wasPressed()) {
    mockProvider.previous();
    changed = true;
  } else if (M5.BtnB.wasPressed()) {
    mockProvider.next();
    changed = true;
  } else if (M5.BtnC.wasPressed()) {
    changed = true;
  }

  if (changed) {
    loadCurrentCase();
    drawDashboard();
  }

  M5.delay(1);
}
