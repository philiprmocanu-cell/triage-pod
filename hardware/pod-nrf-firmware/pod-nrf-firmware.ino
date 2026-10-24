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

static const int TALK_PIN = D0;   // optional: a wire from D0 to GND = "talk" press
MAX30105 finger;

const int N = 100;  // 4 s at 25 samples/s
uint32_t irBuf[N], redBuf[N];
int filled = 0, sinceCalc = 0;
uint32_t noFingerIR = 0, lastIR = 0;
int32_t spo2 = 0, heartRate = 0;
int8_t spo2Ok = 0, hrOk = 0;
bool fingerOn = false, sensorOk = false;
uint32_t presses = 0, lastPress = 0;
bool talkWas = false;

void readFinger() {
  if (!sensorOk) return;
  finger.check();
  while (finger.available()) {
    uint32_t ir = finger.getFIFOIR(), red = finger.getFIFORed();
    finger.nextSample();
    lastIR = ir;
    if (filled < N) {
      irBuf[filled] = ir; redBuf[filled] = red; filled++;
    } else {
      memmove(irBuf, irBuf + 1, (N - 1) * sizeof(uint32_t));
      memmove(redBuf, redBuf + 1, (N - 1) * sizeof(uint32_t));
      irBuf[N - 1] = ir; redBuf[N - 1] = red;
    }
    sinceCalc++;
  }
  fingerOn = lastIR > noFingerIR + 30000;   // a fingertip reflects far more infrared than open air
  if (!fingerOn) { filled = 0; spo2Ok = hrOk = 0; return; }
  if (filled == N && sinceCalc >= 25) {     // recompute once a second
    sinceCalc = 0;
    maxim_heart_rate_and_oxygen_saturation(irBuf, N, redBuf, &spo2, &spo2Ok, &heartRate, &hrOk);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(TALK_PIN, INPUT_PULLUP);
  Wire.begin();                              // SDA D4, SCL D5
  sensorOk = finger.begin(Wire, I2C_SPEED_FAST);
  if (sensorOk) {
    finger.setup(60, 4, 2, 100, 411, 4096);  // brightness, averaging, red+IR, 100 Hz, 411 us, range
    delay(1000);
    finger.check();
    noFingerIR = finger.getIR();             // open-air baseline at power-on: keep fingers off for 1 s
  }
}

void loop() {
  readFinger();
  bool talk = digitalRead(TALK_PIN) == LOW;
  if (talk && !talkWas && millis() - lastPress > 300) { presses++; lastPress = millis(); }
  talkWas = talk;
  static uint32_t lastOut = 0;
  if (millis() - lastOut >= 1000) {
    lastOut = millis();
    JsonDocument d;
    d["finger"] = fingerOn;
    d["hr"] = (fingerOn && hrOk && heartRate > 30 && heartRate < 220) ? heartRate : 0;
    d["spo2"] = (fingerOn && spo2Ok && spo2 > 50) ? spo2 : 0;
    d["presses"] = presses;
    d["sensor"] = sensorOk;
    d["ir"] = lastIR;
    serializeJson(d, Serial);
    Serial.println();
  }
  delay(5);
}
