// Triage Pod, finger unit: XIAO nRF52840 Sense + SparkFun MAX30101 (I2C on D4 = SDA, D5 = SCL).
//
// Built at the venue on a breadboard, no soldering. The laptop is the camera, the voice and the brain;
// this board only measures pulse + oxygen and reports them over the USB cable, one JSON line per second:
//   {"finger":true,"hr":72,"spo2":98,"presses":0,"sensor":true}
// hr / spo2 are 0 until a steady reading exists (contract with hardware/pod-serial-bridge.py). "presses" counts the XIAO's on-board button? The nRF52840
// XIAO has no user button on the top face, so a jumper from D0 to GND (momentary touch) counts as "talk".
//
// Board: Seeed XIAO nRF52840 Sense (arduino-cli FQBN Seeeduino:nrf52:xiaonRF52840Sense).
// Libraries: SparkFun MAX3010x (MAX30105.h + spo2_algorithm.h), ArduinoJson.
// NOT a medical device: the oxygen number is an estimate from a hobby sensor.

#include <Wire.h>
#include <ArduinoJson.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
#include "heartRate.h"

static const int TALK_PIN = D0;   // optional: a wire from D0 to GND = "talk" press
static const uint32_t FINGER_IR = 10000;  // infrared level that means a fingertip is on the window (measured at range 16384: air ~400, finger ~60,000)
MAX30105 finger;

// Oxygen: Maxim's algorithm over 4 s of 25 Hz samples (every 4th raw sample).
// Pulse: time between heartbeats found in the raw 100 Hz infrared signal, median of the last 8 beats.
const int N = 100;
uint32_t irBuf[N], redBuf[N];
int filled = 0, sinceCalc = 0, decim = 0;
uint32_t lastIR = 0;
int32_t spo2 = 0, hrMaxim = 0;
int8_t spo2Ok = 0, hrOk = 0;
bool fingerOn = false, sensorOk = false;
uint32_t presses = 0, lastPress = 0;
bool talkWas = false;
uint32_t loops = 0, samples = 0;
uint32_t lastBeat = 0;
int beats[8] = {0, 0, 0, 0, 0, 0, 0, 0}; int nBeats = 0, beatIdx = 0;
int spo2Hist[5] = {0, 0, 0, 0, 0}; int spo2Idx = 0, nSpo2 = 0;
int hrHist[5] = {0, 0, 0, 0, 0}; int hrIdx = 0, nHr = 0;
int heartRate = 0;

static int medianOf(int *a, int n) {
  int b[8]; for (int i = 0; i < n; i++) b[i] = a[i];
  for (int i = 1; i < n; i++) { int v = b[i], j = i - 1; while (j >= 0 && b[j] > v) { b[j + 1] = b[j]; j--; } b[j + 1] = v; }
  return b[n / 2];
}

uint32_t lastRetry = 0, lastGood = 0;

void startSensor() {
  sensorOk = finger.begin(Wire, I2C_SPEED_FAST);
  if (sensorOk) {
    finger.setup(50, 1, 2, 100, 411, 16384); // brightness, no averaging (raw 100 Hz for beats), red+IR, 411 us, wide range (no clipping)
    lastGood = millis();
  }
}

void readFinger() {
  if (!sensorOk) {                           // keep looking: a re-plugged sensor comes alive without a reboot
    if (millis() - lastRetry > 2000) { lastRetry = millis(); startSensor(); }
    return;
  }
  finger.check();
  int budget = 64;                           // never spin here for ever
  while (finger.available() && budget-- > 0) {
    samples++; lastGood = millis();
    uint32_t ir = finger.getFIFOIR(), red = finger.getFIFORed();
    finger.nextSample();
    lastIR = ir;
    // pulse from beats in the raw signal
    if (checkForBeat((int32_t)ir)) {
      uint32_t now = millis();
      if (lastBeat) {
        int bpm = 60000 / (int)(now - lastBeat);
        bool plausible = bpm >= 35 && bpm <= 200;
        if (plausible && nBeats >= 3) { int m = medianOf(beats, nBeats); if (bpm > m * 16 / 10 || bpm < m * 6 / 10) plausible = false; }   // a beat twice as fast or slow as the rest is noise
        if (plausible) { beats[beatIdx] = bpm; beatIdx = (beatIdx + 1) % 8; if (nBeats < 8) nBeats++; }
      }
      lastBeat = now;
    }
    // oxygen from every 4th sample
    if (++decim >= 4) {
      decim = 0;
      if (filled < N) { irBuf[filled] = ir; redBuf[filled] = red; filled++; }
      else {
        memmove(irBuf, irBuf + 1, (N - 1) * sizeof(uint32_t));
        memmove(redBuf, redBuf + 1, (N - 1) * sizeof(uint32_t));
        irBuf[N - 1] = ir; redBuf[N - 1] = red;
      }
      sinceCalc++;
    }
  }
  if (millis() - lastGood > 3000) { sensorOk = false; fingerOn = false; lastIR = 0; return; }   // no samples for 3 s: the sensor is gone
  fingerOn = lastIR > FINGER_IR;             // a fingertip reflects far more infrared than open air (see FINGER_IR)
  if (!fingerOn) { filled = 0; spo2Ok = 0; nBeats = 0; nSpo2 = 0; nHr = 0; lastBeat = 0; heartRate = 0; return; }
  if (filled == N && sinceCalc >= 25) {     // recompute oxygen once a second
    sinceCalc = 0;
    maxim_heart_rate_and_oxygen_saturation(irBuf, N, redBuf, &spo2, &spo2Ok, &hrMaxim, &hrOk);
    if (spo2Ok && spo2 > 50 && spo2 <= 100) { spo2Hist[spo2Idx] = spo2; spo2Idx = (spo2Idx + 1) % 5; if (nSpo2 < 5) nSpo2++; }
    if (hrOk && hrMaxim >= 35 && hrMaxim <= 200) { hrHist[hrIdx] = hrMaxim; hrIdx = (hrIdx + 1) % 5; if (nHr < 5) nHr++; }
  }
  if (nBeats >= 3 && millis() - lastBeat < 3000) heartRate = medianOf(beats, nBeats);   // median of the last 8 beats: one bad beat cannot move it
  else heartRate = 0;                                                // no steady beats yet: say 0, never guess
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 8; i++) { delay(500); Serial.println("boot"); }   // 4 s of hellos so the laptop catches one
  pinMode(TALK_PIN, INPUT_PULLUP);
  // Unstick the I2C bus if a sensor is holding the data line low: clock SCL 9 times, then a STOP.
  pinMode(D4, INPUT_PULLUP); pinMode(D5, OUTPUT);
  for (int i = 0; i < 9 && digitalRead(D4) == LOW; i++) { digitalWrite(D5, LOW); delayMicroseconds(5); digitalWrite(D5, HIGH); delayMicroseconds(5); }
  pinMode(D4, OUTPUT); digitalWrite(D4, LOW); delayMicroseconds(5); digitalWrite(D5, HIGH); delayMicroseconds(5); digitalWrite(D4, HIGH);
  Serial.println(digitalRead(D4) == HIGH ? "sda high (bus free)" : "sda LOW (bus stuck: check the white wire)");
  Serial.println(digitalRead(D5) == HIGH ? "scl high" : "scl LOW (check the yellow wire)");
  Wire.begin();                              // SDA D4, SCL D5
  Serial.println("i2c up");
  startSensor();
  Serial.println(sensorOk ? "sensor found" : "sensor MISSING (will keep looking)");
}

void loop() {
  loops++;
  readFinger();
  bool talk = digitalRead(TALK_PIN) == LOW;
  if (talk && !talkWas && millis() - lastPress > 300) { presses++; lastPress = millis(); }
  talkWas = talk;
  static uint32_t lastOut = 0;
  if (millis() - lastOut >= 1000) {
    lastOut = millis();
    JsonDocument d;
    d["finger"] = fingerOn;
    d["hr"] = fingerOn ? heartRate : 0;
    d["spo2"] = (fingerOn && nSpo2 >= 3) ? medianOf(spo2Hist, nSpo2) : 0;
    d["presses"] = presses;
    d["sensor"] = sensorOk;
    d["ir"] = lastIR;
    d["loops"] = loops; d["samples"] = samples; d["hr_maxim"] = (fingerOn && hrOk) ? hrMaxim : 0;
    loops = samples = 0;
    serializeJson(d, Serial);
    Serial.println();
  }
  delay(5);
}
