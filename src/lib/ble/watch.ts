// The patient's watch, over Bluetooth, into the pod page. Standard Heart Rate and Pulse Oximeter
// services only: the page reads the pulse (and oxygen, when the watch sends it). A user gesture
// has to call connectWatch — the browser will not open the device list on its own.

export type WatchReading = {
  name: string;
  hr: number | null;
  spo2: number | null;
  finger: boolean; // the sensor says skin is on the window (the red light)
};

type BleChar = {
  startNotifications: () => Promise<BleChar>;
  addEventListener: (type: string, fn: () => void) => void;
  value?: DataView | null;
};

type BleServer = { getPrimaryService: (id: string) => Promise<{ getCharacteristic: (id: string) => Promise<BleChar> }> };
type BleDevice = { name?: string; gatt?: { connect: () => Promise<BleServer>; disconnect: () => void } };

export function watchAvailable(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

// Heart Rate Measurement (0x2A37). Bit 0 selects 8 or 16 bits. Bits 1 and 2 are skin contact.
export function parseHeartRate(data: DataView): { hr: number; finger: boolean | null } {
  const flags = data.getUint8(0);
  const wide = (flags & 0x01) !== 0;
  const hr = wide ? data.getUint16(1, true) : data.getUint8(1);
  const contactKnown = (flags & 0x04) !== 0;
  const contact = (flags & 0x02) !== 0;
  return { hr, finger: contactKnown ? contact : null };
}

// IEEE-11073 16-bit float used by the pulse-oximeter measurement.
export function parseSfloat(raw: number): number | null {
  let mantissa = raw & 0x0fff;
  let exponent = (raw >> 12) & 0x0f;
  if (mantissa === 0x07ff || mantissa === 0x0800 || mantissa === 0x07fe || mantissa === 0x0801) return null;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x0008) exponent -= 0x0010;
  const value = mantissa * 10 ** exponent;
  return Number.isFinite(value) ? value : null;
}

// Pulse-ox spot check and continuous measurement share the same first five bytes.
export function parsePulseOx(data: DataView): { spo2: number | null; hr: number | null } {
  if (data.byteLength < 5) return { spo2: null, hr: null };
  const spo2 = parseSfloat(data.getUint16(1, true));
  const hr = parseSfloat(data.getUint16(3, true));
  return {
    spo2: spo2 != null && spo2 >= 50 && spo2 <= 100 ? Math.round(spo2) : null,
    hr: hr != null && hr >= 20 && hr <= 240 ? Math.round(hr) : null,
  };
}

function plausible(hr: number | null): hr is number {
  return hr != null && hr >= 20 && hr <= 240;
}

async function listen(server: BleServer, serviceId: string, charId: string, onValue: (view: DataView) => void): Promise<boolean> {
  try {
    const service = await server.getPrimaryService(serviceId);
    const characteristic = await service.getCharacteristic(charId);
    await characteristic.startNotifications();
    characteristic.addEventListener("characteristicvaluechanged", () => {
      if (characteristic.value) onValue(characteristic.value);
    });
    if (characteristic.value) onValue(characteristic.value);
    return true;
  } catch {
    return false;
  }
}

export async function connectWatch(onReading: (reading: WatchReading) => void, opts?: { anyDevice?: boolean }): Promise<() => void> {
  const bluetooth = (navigator as Navigator & { bluetooth: { requestDevice: (opts: unknown) => Promise<BleDevice> } }).bluetooth;
  const optional = ["heart_rate", "pulse_oximeter"];
  const device = await bluetooth.requestDevice(
    opts?.anyDevice
      ? { acceptAllDevices: true, optionalServices: optional }
      : { filters: [{ services: ["heart_rate"] }, { services: ["pulse_oximeter"] }], optionalServices: optional },
  );
  const server = await device.gatt?.connect();
  if (!server) throw new Error("The watch did not open a connection.");
  const name = device.name || "Watch";
  let hr: number | null = null;
  let spo2: number | null = null;
  let finger = false;
  const emit = () => {
    if (!plausible(hr) && spo2 == null) return;
    onReading({ name, hr: plausible(hr) ? hr : null, spo2, finger });
  };
  const heart = await listen(server, "heart_rate", "heart_rate_measurement", (view) => {
    const parsed = parseHeartRate(view);
    if (!plausible(parsed.hr)) return;
    hr = parsed.hr;
    if (parsed.finger != null) finger = parsed.finger;
    emit();
  });
  const ox = await listen(server, "pulse_oximeter", "plx_continuous_measurement", (view) => {
    const parsed = parsePulseOx(view);
    if (parsed.spo2 != null) spo2 = parsed.spo2;
    if (plausible(parsed.hr)) hr = parsed.hr;
    if (parsed.spo2 != null) finger = true;
    emit();
  });
  const spot = ox
    ? false
    : await listen(server, "pulse_oximeter", "plx_spot_check_measurement", (view) => {
        const parsed = parsePulseOx(view);
        if (parsed.spo2 != null) spo2 = parsed.spo2;
        if (plausible(parsed.hr)) hr = parsed.hr;
        if (parsed.spo2 != null) finger = true;
        emit();
      });
  if (!heart && !ox && !spot) {
    device.gatt?.disconnect();
    throw new Error("This device does not share a pulse. Choose the watch that advertises heart rate.");
  }
  return () => device.gatt?.disconnect();
}
