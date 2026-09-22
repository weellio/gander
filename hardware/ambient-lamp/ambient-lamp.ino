/*
 * Gander ambient lamp — a ~$4 USB-powered alert light.
 * ---------------------------------------------------------------------------
 * Gander's ambient alerts POST this JSON to a URL you choose, per scenario:
 *
 *   { "event":"awaiting", "color":"amber", "effect":"pulse",
 *     "project":"shop", "agent":"…", "reason":"…", "state":"…", "at":1789… }
 *
 * This sketch turns a $2 WiFi board + a few WS2812 LEDs into that URL.
 * Point Settings → App configuration → Ambient alerts at:
 *
 *   http://gander-lamp.local/alert      (or http://<ip>/alert)
 *
 * Board: any ESP8266 (Wemos D1 mini) or ESP32 / ESP32-C3 (SuperMini).
 * Library: "Adafruit NeoPixel" (Library Manager) — that's the only one.
 * Power:  the board's own USB port. Nothing else needed.
 *
 * Open http://<ip>/ in a browser for a status page + test buttons.
 */

#include <Adafruit_NeoPixel.h>

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266WebServer.h>
  #include <ESP8266mDNS.h>
  ESP8266WebServer server(80);
#else
  #include <WiFi.h>
  #include <WebServer.h>
  #include <ESPmDNS.h>
  WebServer server(80);
#endif

// ── 1. PICK YOUR BOARD — uncomment ONE line, comment out the rest ───────────
#define BOARD_ESP32_S3         // YD-ESP32-S3 or ESP32-S3-DevKitC-1 — onboard RGB, no wiring
//#define BOARD_C3_SUPERMINI   // ESP32-C3 SuperMini — onboard RGB, no wiring
//#define BOARD_D1_MINI        // Wemos D1 mini (ESP8266) + a WS2812 strip on the pin marked D2

// ── 2. YOUR WIFI — 2.4 GHz only. These chips cannot see a 5 GHz network. ────
const char* WIFI_SSID = "pewpewpew";
const char* WIFI_PASS = "superman";
// ────────────────────────────────────────────────────────────────────────────

#if defined(BOARD_ESP32_S3)
  #define LED_PIN    48   // a few S3 revisions wire it to 38 instead — try that if it stays dark
  #define LED_COUNT  1
#elif defined(BOARD_C3_SUPERMINI)
  #define LED_PIN    8
  #define LED_COUNT  1
#elif defined(BOARD_D1_MINI)
  #define LED_PIN    4    // the pin marked D2
  #define LED_COUNT  8
#else
  #error "Uncomment exactly one BOARD_ line above."
#endif
#define MAX_BRIGHTNESS 70   // 0-255. Keep ≤70 for 8 LEDs on a 500 mA USB port.
#define HOSTNAME       "gander-lamp"

// ── Optional: a plain SINGLE-COLOUR strip (the 12V rolls everyone has spare) ──
// Drive it through a logic-level N-MOSFET; see hardware/README.md for wiring.
// The strip needs its OWN supply — a 12V roll is far beyond what USB can give.
// Patterns work exactly the same; colour becomes brightness (see renderEffect).
#define MONO_PIN   -1       // GPIO driving the MOSFET gate. -1 = not used.
#define MONO_MAX   255      // 0-255 ceiling, in case the roll is blinding

Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

// current alert
uint8_t  curR = 0, curG = 0, curB = 0;
String   curEffect = "solid";
String   lastEvent = "(none)";
String   lastProject = "";
uint32_t lastAt = 0;

// ── colour parsing: "#rrggbb", a known name, or "off" ───────────────────────
struct NamedColor { const char* name; uint8_t r, g, b; };
const NamedColor COLORS[] = {
  {"red",      255,   0,   0}, {"green",     0, 200,  60}, {"limegreen", 16, 185, 129},
  {"blue",       0,  80, 255}, {"amber",   245, 158,  11}, {"orange",   255, 110,   0},
  {"yellow",   255, 210,   0}, {"purple",  150,  60, 255}, {"magenta",  255,   0, 160},
  {"cyan",       0, 200, 255}, {"pink",    255, 100, 160}, {"white",    255, 255, 255},
};

uint8_t hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

void setColorFromString(String c) {
  c.trim(); c.toLowerCase();
  if (c == "off" || c.length() == 0) { curR = curG = curB = 0; return; }
  if (c[0] == '#' && c.length() >= 7) {
    curR = hexNibble(c[1]) * 16 + hexNibble(c[2]);
    curG = hexNibble(c[3]) * 16 + hexNibble(c[4]);
    curB = hexNibble(c[5]) * 16 + hexNibble(c[6]);
    return;
  }
  for (unsigned i = 0; i < sizeof(COLORS) / sizeof(COLORS[0]); i++) {
    if (c == COLORS[i].name) { curR = COLORS[i].r; curG = COLORS[i].g; curB = COLORS[i].b; return; }
  }
  curR = curG = curB = 255;   // unknown name → white, never silently dark
}

// ── minimal JSON field grab (fixed payload shape — no library needed) ───────
String jsonStr(const String& body, const char* key) {
  String needle = String("\"") + key + "\"";
  int k = body.indexOf(needle);
  if (k < 0) return "";
  int colon = body.indexOf(':', k + needle.length());
  if (colon < 0) return "";
  int q1 = body.indexOf('"', colon);
  if (q1 < 0) return "";
  int q2 = q1 + 1;
  String out = "";
  while (q2 < (int)body.length() && body[q2] != '"') {
    if (body[q2] == '\\' && q2 + 1 < (int)body.length()) q2++;   // keep escaped chars literal
    out += body[q2++];
  }
  return out;
}

void showSolid(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, strip.Color(r, g, b));
  strip.show();
}

// ── mono strip PWM (no-ops entirely when MONO_PIN is -1) ────────────────────
// The PWM call moved between ESP32 core 2.x and 3.x, so both are handled.
void monoSetup() {
#if MONO_PIN >= 0
  #if defined(ESP8266)
    analogWriteRange(255);
    pinMode(MONO_PIN, OUTPUT);
  #elif defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(MONO_PIN, 1000, 8);
  #else
    ledcSetup(0, 1000, 8);
    ledcAttachPin(MONO_PIN, 0);
  #endif
#endif
}

void monoWrite(uint8_t v) {
#if MONO_PIN >= 0
  uint8_t out = (uint16_t)v * MONO_MAX / 255;
  #if defined(ESP8266)
    analogWrite(MONO_PIN, out);
  #elif defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(MONO_PIN, out);
  #else
    ledcWrite(0, out);
  #endif
#else
  (void)v;
#endif
}

// ── effect engine — non-blocking so the HTTP server stays responsive ────────
void renderEffect() {
  uint32_t t = millis();

  // "off" colour → dark, whatever the pattern says
  if (curR == 0 && curG == 0 && curB == 0) { showSolid(0, 0, 0); monoWrite(0); return; }

  if (curEffect == "rainbow") {
    uint16_t base = (t / 6) % 65536;
    for (int i = 0; i < LED_COUNT; i++) {
      uint16_t hue = base + (uint32_t)i * (65536 / LED_COUNT);
      strip.setPixelColor(i, strip.gamma32(strip.ColorHSV(hue, 255, 255)));
    }
    strip.show();
    // a single-colour strip has no hue to cycle, so it breathes instead
    float lv = (1.0f - cosf(((t % 2400) / 2400.0f) * 2.0f * PI)) * 0.5f;
    monoWrite((uint8_t)(255 * (0.15f + lv * 0.85f)));
    return;
  }

  float level;   // 0..1 brightness for this instant — one curve, both outputs
  if (curEffect == "blink")       level = ((t / 500) % 2 == 0) ? 1.0f : 0.0f;
  else if (curEffect == "strobe") level = ((t /  80) % 2 == 0) ? 1.0f : 0.0f;
  else if (curEffect == "pulse" || curEffect == "breathe") {
    uint32_t period = (curEffect == "breathe") ? 4000 : 1400;   // breathe is slower + calmer
    float phase = (t % period) / (float)period;                 // 0..1
    float lv = (1.0f - cosf(phase * 2.0f * PI)) * 0.5f;         // smooth 0..1..0
    float floorLvl = (curEffect == "breathe") ? 0.12f : 0.05f;  // never fully dark
    level = floorLvl + lv * (1.0f - floorLvl);
  }
  else level = 1.0f;   // "solid" and anything unknown

  showSolid((uint8_t)(curR * level), (uint8_t)(curG * level), (uint8_t)(curB * level));

  // Mono strip can't show hue, so the brightest channel becomes its brightness.
  // Any lit colour reads as "on"; only "off" goes dark. Pattern carries the meaning.
  uint8_t peak = curR > curG ? (curR > curB ? curR : curB) : (curG > curB ? curG : curB);
  monoWrite((uint8_t)(peak * level));
}

// ── HTTP ────────────────────────────────────────────────────────────────────
void handleAlert() {
  String body = server.arg("plain");
  String event  = jsonStr(body, "event");
  String color  = jsonStr(body, "color");
  String effect = jsonStr(body, "effect");

  if (color.length())  setColorFromString(color);
  if (effect.length()) curEffect = effect;
  lastEvent   = event.length() ? event : String("(no event)");
  lastProject = jsonStr(body, "project");
  lastAt      = millis();

  Serial.printf("[alert] %s  %s / %s  %s\n", lastEvent.c_str(), color.c_str(), effect.c_str(), lastProject.c_str());
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleTest() {
  setColorFromString(server.hasArg("color") ? server.arg("color") : "amber");
  curEffect = server.hasArg("effect") ? server.arg("effect") : "pulse";
  lastEvent = "test";
  server.sendHeader("Location", "/");
  server.send(302, "text/plain", "");
}

void handleRoot() {
  String h = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>";
  h += "<style>body{font:14px system-ui;margin:24px;max-width:34rem}a{display:inline-block;margin:3px 6px 3px 0;padding:6px 11px;";
  h += "border:1px solid #ccc;border-radius:7px;text-decoration:none;color:#111}code{background:#f3f3f3;padding:1px 5px;border-radius:4px}</style>";
  h += "<h2>Gander ambient lamp</h2>";
  h += "<p>Point Gander's ambient webhook at:<br><code>http://" + WiFi.localIP().toString() + "/alert</code>";
  h += "<br><code>http://" HOSTNAME ".local/alert</code></p>";
  h += "<p>Last alert: <b>" + lastEvent + "</b>";
  if (lastProject.length()) h += " &middot; " + lastProject;
  // String(...) around each number: Arduino's String + unsigned char would append a character, not a digit
  h += "<br>Showing: " + curEffect + " @ rgb(" + String(curR) + "," + String(curG) + "," + String(curB) + ")</p>";
  h += "<p>Test: <a href='/test?color=amber&effect=pulse'>needs you</a>";
  h += "<a href='/test?color=red&effect=blink'>error</a>";
  h += "<a href='/test?color=red&effect=strobe'>runaway</a>";
  h += "<a href='/test?color=green&effect=pulse'>done</a>";
  h += "<a href='/test?color=off&effect=solid'>all clear</a></p>";
  server.send(200, "text/html", h);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  strip.begin();
  strip.setBrightness(MAX_BRIGHTNESS);
  monoSetup();
  monoWrite(0);
  showSolid(0, 0, 40);                       // dim blue = booting / connecting

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("\nconnecting");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\nconnected: http://%s/  (http://%s.local/)\n", WiFi.localIP().toString().c_str(), HOSTNAME);

  if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);

  server.on("/", handleRoot);
  server.on("/alert", HTTP_POST, handleAlert);
  server.on("/alert", HTTP_GET, handleRoot);   // friendly if you paste it in a browser
  server.on("/test", handleTest);
  server.begin();

  showSolid(0, 40, 0);                       // brief green = ready
  monoWrite(40);
  delay(600);
  curR = curG = curB = 0;                    // then idle/dark until the first alert
  monoWrite(0);
}

void loop() {
  server.handleClient();
#if defined(ESP8266)
  MDNS.update();
#endif
  renderEffect();
  delay(8);
}
