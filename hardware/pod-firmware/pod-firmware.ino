// Triage Pod head: the wireless, battery-powered part of the pod.
//
//   Eyes   Grove Vision AI V2 + camera, over UART (XIAO D6/D7) -> JPEG pictures
//   Finger SparkFun MAX30101 pulse-oximetry sensor, over I2C (Qwiic) -> pulse + oxygen
//   Button the XIAO's BOOT button -> "talk" (the laptop starts listening)
//   Link   Wi-Fi; the laptop's browser reads http://triagepod.local/frame and /vitals
//
// The laptop does everything else: it speaks the questions, listens, and runs the triage.
// Board: Seeed XIAO ESP32-S3 (arduino-cli FQBN esp32:esp32:XIAO_ESP32S3:PSRAM=opi).
//
// NOT a medical device: the oxygen number is an estimate from a hobby sensor.

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include "secrets.h"  // WIFI_SSID, WIFI_PASS (copy secrets.example.h)

static const char *HOSTNAME = "triagepod";
static const int BUTTON_PIN = 0;  // BOOT button on the XIAO

WebServer server(80);
MAX30105 finger;

// ---- Camera (Vision AI V2 speaks SSCMA "AT" commands; replies are JSON lines) ----

HardwareSerial &cam = Serial1;
SemaphoreHandle_t frameLock;
String latestFrame;          // base64 JPEG, newest picture
uint32_t frameAt = 0, frames = 0;
volatile bool camOk = false;

// Send one AT command and return the JSON reply whose "name" matches, or "" on timeout.
String camAsk(const char *cmd, const char *name, uint32_t timeoutMs) {
  while (cam.available()) cam.read();
  cam.print(cmd);
  cam.print("\r\n");
  String line;
  line.reserve(80 * 1024);
  uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (cam.available()) {
      char c = cam.read();
      if (c == '\n') {
        int brace = line.indexOf('{');
        if (brace >= 0 && line.indexOf(name) >= 0) return line.substring(brace);
        line = "";
      } else if (c != '\r') {
        line += c;
      }
    }
    delay(1);
  }
  return "";
}

// Pull "image" out of a reply without parsing the whole (large) JSON.
String imageOf(const String &json) {
  int k = json.indexOf("\"image\":\"");
  if (k < 0) return "";
  int s = k + 9, e = json.indexOf('"', s);
  return e > s ? json.substring(s, e) : "";
}

void cameraTask(void *) {
  cam.setRxBufferSize(64 * 1024);
  cam.begin(921600, SERIAL_8N1, D7, D6);  // RX = D7, TX = D6
  delay(1500);
  camAsk("AT+SENSOR=1,1,1", "SENSOR", 2000);  // camera on, 480x480 so faces have enough detail
  for (;;) {
    // SAMPLE takes a picture without needing any model loaded on the Vision AI board.
    String reply = camAsk("AT+SAMPLE=1", "SAMPLE", 3000);
    String img = imageOf(reply);
    if (img.length() > 1000) {
      xSemaphoreTake(frameLock, portMAX_DELAY);
      latestFrame = img;
      frameAt = millis();
      frames++;
      xSemaphoreGive(frameLock);
      camOk = true;
    } else {
      camOk = false;
      delay(300);
    }
  }
}

// ---- Finger sensor: pulse + oxygen (Maxim's algorithm over the last 4 seconds) ----

const int N = 100;  // 4 s at 25 samples/s
uint32_t irBuf[N], redBuf[N];
int filled = 0, sinceCalc = 0;
uint32_t noFingerIR = 0;
int32_t spo2 = 0, heartRate = 0;
int8_t spo2Ok = 0, hrOk = 0;
bool fingerOn = false, sensorOk = false;
uint32_t lastIR = 0;

void readFinger() {
  if (!sensorOk) return;
  finger.check();
  while (finger.available()) {
    uint32_t ir = finger.getFIFOIR(), red = finger.getFIFORed();
    finger.nextSample();
    lastIR = ir;
    if (filled < N) {
      irBuf[filled] = ir;
      redBuf[filled] = red;
      filled++;
    } else {
      memmove(irBuf, irBuf + 1, (N - 1) * sizeof(uint32_t));
      memmove(redBuf, redBuf + 1, (N - 1) * sizeof(uint32_t));
      irBuf[N - 1] = ir;
      redBuf[N - 1] = red;
    }
    sinceCalc++;
  }
  // A fingertip reflects far more infrared light than open air.
  fingerOn = lastIR > noFingerIR + 30000;
  if (!fingerOn) {
    filled = 0;
    spo2Ok = hrOk = 0;
    return;
  }
  if (filled == N && sinceCalc >= 25) {  // recompute once a second
    sinceCalc = 0;
    maxim_heart_rate_and_oxygen_saturation(irBuf, N, redBuf, &spo2, &spo2Ok, &heartRate, &hrOk);
  }
}

// ---- Button: count presses; the laptop reacts to each new press ----

volatile uint32_t presses = 0;
void IRAM_ATTR onButton() {
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last > 300) presses++;
  last = now;
}

// ---- Web: the laptop polls these ----

void cors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
}

void handleFrame() {
  cors();
  xSemaphoreTake(frameLock, portMAX_DELAY);
  String f = latestFrame;
  uint32_t age = millis() - frameAt;
  xSemaphoreGive(frameLock);
  if (!f.length()) return server.send(503, "text/plain", "no picture yet");
  server.sendHeader("X-Frame-Age-Ms", String(age));
  server.send(200, "text/plain", f);  // base64 JPEG
}

void handleVitals() {
  cors();
  JsonDocument d;
  d["finger"] = fingerOn;
  d["hr"] = (fingerOn && hrOk && heartRate > 30 && heartRate < 220) ? heartRate : -1;
  d["spo2"] = (fingerOn && spo2Ok && spo2 > 50) ? spo2 : -1;
  d["presses"] = presses;
  d["camera"] = camOk;
  d["frames"] = frames;
  d["sensor"] = sensorOk;
  d["battery_mv"] = analogReadMilliVolts(A0) * 2;  // only meaningful with a divider on A0
  String out;
  serializeJson(d, out);
  server.send(200, "application/json", out);
}

void setup() {
  Serial.begin(115200);
  frameLock = xSemaphoreCreateMutex();
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), onButton, FALLING);

  Wire.begin();  // SDA D4, SCL D5
  sensorOk = finger.begin(Wire, I2C_SPEED_FAST);
  if (sensorOk) {
    finger.setup(60, 4, 2, 100, 411, 4096);  // brightness, averaging, red+IR, 100 Hz, 411 us, range
    delay(1000);
    finger.check();
    noFingerIR = finger.getIR();  // open-air baseline at power-on: keep fingers off for 1 s
  }
  Serial.printf("finger sensor: %s (baseline IR %u)\n", sensorOk ? "ok" : "MISSING", noFingerIR);

  xTaskCreatePinnedToCore(cameraTask, "camera", 16384, nullptr, 1, nullptr, 0);

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("wifi");
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nwifi %s  ip %s\n", WiFi.status() == WL_CONNECTED ? "connected" : "FAILED", WiFi.localIP().toString().c_str());
  MDNS.begin(HOSTNAME);  // http://triagepod.local
  MDNS.addService("http", "tcp", 80);

  server.on("/frame", handleFrame);
  server.on("/vitals", handleVitals);
  server.on("/", []() {
    cors();
    server.send(200, "text/plain", "Triage Pod head. Endpoints: /frame (base64 JPEG), /vitals (JSON).");
  });
  server.begin();
}

void loop() {
  server.handleClient();
  readFinger();
  static uint32_t lastPrint = 0;
  if (millis() - lastPrint > 2000) {
    lastPrint = millis();
    Serial.printf("ip %s  frames %u  camera %s  finger %s  hr %d  spo2 %d  presses %u\n", WiFi.localIP().toString().c_str(), frames,
                  camOk ? "ok" : "--", fingerOn ? "on" : "off", hrOk ? heartRate : -1, spo2Ok ? spo2 : -1, presses);
  }
}
