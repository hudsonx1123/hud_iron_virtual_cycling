// Web Bluetooth: FTMS 訓練台 (0x1826) 與心率帶 (0x180D)
const FTMS = 0x1826, BIKE_DATA = 0x2ad2, CONTROL_POINT = 0x2ad9;
const HR_SVC = 0x180d, HR_MEAS = 0x2a37;

export const bleSupported = () => !!navigator.bluetooth;

// Indoor Bike Data 欄位依 flags 順序出現
function parseBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = {};
  if (!(flags & 0x01)) { out.speed = dv.getUint16(o, true) / 100; o += 2; } // km/h
  if (flags & 0x02) o += 2;                                                  // avg speed
  if (flags & 0x04) { out.cadence = dv.getUint16(o, true) / 2; o += 2; }
  if (flags & 0x08) o += 2;                                                  // avg cadence
  if (flags & 0x10) o += 3;                                                  // total distance
  if (flags & 0x20) o += 2;                                                  // resistance level
  if (flags & 0x40) { out.power = dv.getInt16(o, true); o += 2; }
  if (flags & 0x80) o += 2;                                                  // avg power
  if (flags & 0x100) o += 5;                                                 // energy
  if (flags & 0x200) { out.hr = dv.getUint8(o); o += 1; }
  return out;
}

export class Trainer {
  constructor({ onData, onStatus }) {
    this.onData = onData;
    this.onStatus = onStatus;
    this.connected = false;
    this.queue = Promise.resolve();
  }

  async connect() {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }],
      optionalServices: [FTMS],
    });
    dev.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.onStatus('已斷線');
    });
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(FTMS);

    const bike = await svc.getCharacteristic(BIKE_DATA);
    bike.addEventListener('characteristicvaluechanged', (e) => this.onData(parseBikeData(e.target.value)));
    await bike.startNotifications();

    this.cp = await svc.getCharacteristic(CONTROL_POINT);
    await this.cp.startNotifications().catch(() => {});
    this.connected = true;
    this.name = dev.name || '訓練台';
    this.write([0x00]); // request control
    this.write([0x07]); // start / resume
    this.onStatus(this.name);
  }

  write(bytes) {
    const data = new Uint8Array(bytes);
    this.queue = this.queue
      .then(() => (this.cp.writeValueWithResponse || this.cp.writeValue).call(this.cp, data))
      .catch((e) => console.warn('FTMS write failed', e));
    return this.queue;
  }

  // ERG：Set Target Power (0x05, sint16 watts)
  setTargetPower(w) {
    if (!this.connected) return;
    w = Math.max(0, Math.min(2000, Math.round(w)));
    this.write([0x05, w & 0xff, (w >> 8) & 0xff]);
  }
}

export class HRMonitor {
  constructor({ onHR, onStatus }) {
    this.onHR = onHR;
    this.onStatus = onStatus;
    this.connected = false;
  }

  async connect() {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SVC] }],
    });
    dev.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.onStatus('已斷線');
    });
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(HR_SVC);
    const ch = await svc.getCharacteristic(HR_MEAS);
    ch.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      this.onHR(dv.getUint8(0) & 1 ? dv.getUint16(1, true) : dv.getUint8(1));
    });
    await ch.startNotifications();
    this.connected = true;
    this.onStatus(dev.name || '心率帶');
  }
}
