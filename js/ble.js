// Web Bluetooth: FTMS 訓練台 (0x1826) 與心率帶 (0x180D)
const FTMS = 0x1826, BIKE_DATA = 0x2ad2, CONTROL_POINT = 0x2ad9, STATUS = 0x2ada;
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
    this.writing = false;
    this.targetWatts = null;
    this.needControl = false;
    this.keepAliveTimer = null;
    this._indicationResolve = null;
    this.lastPower = 0;
  }

  async connect() {
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }],
      optionalServices: [FTMS],
    });
    dev.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.writing = false;
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      if (this._indicationResolve) {
        this._indicationResolve(null);
        this._indicationResolve = null;
      }
      this.onStatus('已斷線');
    });
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(FTMS);

    const bike = await svc.getCharacteristic(BIKE_DATA);
    bike.addEventListener('characteristicvaluechanged', (e) => {
      const data = parseBikeData(e.target.value);
      // 即時掉功率攔截：若穩定踩踏中（踏頻 >= 50）功率卻突然掉到目標瓦數的 75% 以下（例如設 145W 卻掉回 80~90W），
      // 立即強制重新要求控制權並重送目標功率，瞬間把阻力拉回
      if (
        this.connected &&
        this.targetWatts >= 100 &&
        data.cadence >= 50 &&
        data.power != null &&
        data.power < this.targetWatts * 0.75
      ) {
        if (this.lastPower >= this.targetWatts * 0.75) {
          this.needControl = true;
        }
        this._flush();
      }
      if (data.power != null) this.lastPower = data.power;
      this.onData(data);
    });
    await bike.startNotifications();

    // 訂閱 Fitness Machine Status (0x2ADA)，監聽訓練台重置或控制權遺失事件
    try {
      const statusCh = await svc.getCharacteristic(STATUS);
      statusCh.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        if (!dv.byteLength) return;
        const op = dv.getUint8(0);
        // 0x01: Reset, 0x02: Stopped/Paused, 0x08: Control Permission Lost
        if (op === 0x01 || op === 0x02 || op === 0x08) {
          console.warn(`FTMS 狀態通知 0x${op.toString(16)}，立即重新取得控制權`);
          this.needControl = true;
          this._flush();
        }
      });
      await statusCh.startNotifications();
    } catch {}

    this.cp = await svc.getCharacteristic(CONTROL_POINT);
    this.cp.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      if (dv.byteLength >= 3 && dv.getUint8(0) === 0x80) {
        const op = dv.getUint8(1), res = dv.getUint8(2);
        if (this._indicationResolve) {
          const resolve = this._indicationResolve;
          this._indicationResolve = null;
          resolve({ op, res });
        }
        // 0x05 = Control Not Permitted（未獲控制權或控制權被其他裝置搶走）
        if (res === 0x05) {
          console.warn(`FTMS 指令 0x${op.toString(16)} 未獲控制權 (0x05)，立即重取控制權`);
          this.needControl = true;
          this._flush();
        } else if (res !== 0x01) {
          const names = { 0x02: '不支援', 0x03: '參數無效', 0x04: '操作失敗' };
          console.warn(`FTMS 控制回應 0x${op.toString(16)}: ${names[res] || '錯誤 ' + res}`);
        }
      }
    });
    await this.cp.startNotifications().catch(() => {});

    this.name = dev.name || '訓練台';
    // 依序完成 Request Control (0x00) 與 Start/Resume (0x07) 握手並等待 Indication 確認
    await this._sendCommand([0x00], 300).catch((e) => console.warn('Request control failed', e));
    await this._sendCommand([0x07], 300).catch(() => {});

    this.connected = true;
    this.onStatus(this.name);

    // 啟動每 800ms 的 ERG 定時心跳刷新（Keep-Alive Heartbeat）
    // 防止訓練台內建的 1.5~2 秒硬體 Watchdog 逾時而將阻力釋放回預設平路（80~90W）
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.connected && this.targetWatts != null) {
        this._flush();
      }
    }, 800);

    if (this.targetWatts != null) this._flush();
  }

  async _sendCommand(bytes, waitMs = 250) {
    if (!this.cp) return null;
    const data = new Uint8Array(bytes);
    const indPromise = new Promise((resolve) => {
      this._indicationResolve = resolve;
      setTimeout(() => {
        if (this._indicationResolve === resolve) {
          this._indicationResolve = null;
          resolve(null);
        }
      }, waitMs);
    });
    try {
      if (this.cp.writeValueWithResponse) {
        await this.cp.writeValueWithResponse(data);
      } else if (this.cp.writeValue) {
        await this.cp.writeValue(data);
      }
    } catch (e) {
      this._indicationResolve = null;
      throw e;
    }
    return await indPromise;
  }

  // ERG：Set Target Power (0x05, sint16 watts)
  setTargetPower(w) {
    w = Math.max(0, Math.min(2000, Math.round(w)));
    const changed = this.targetWatts !== w;
    this.targetWatts = w;
    if (this.connected && changed) {
      this._flush();
    }
  }

  async _flush() {
    if (!this.connected || this.writing || this.targetWatts == null) return;
    this.writing = true;
    try {
      if (this.needControl) {
        this.needControl = false;
        await this._sendCommand([0x00], 200).catch(() => {});
      }
      const w = this.targetWatts;
      const resp = await this._sendCommand([0x05, w & 0xff, (w >> 8) & 0xff], 200);
      // 若訓練台回覆 0x05 (Control Not Permitted)，立即重新要求控制權並重送目標瓦數
      if (resp && resp.res === 0x05) {
        this.needControl = false;
        await this._sendCommand([0x00], 200).catch(() => {});
        await this._sendCommand([0x07], 200).catch(() => {});
        await this._sendCommand([0x05, w & 0xff, (w >> 8) & 0xff], 200);
      }
    } catch (e) {
      console.warn('FTMS setTargetPower failed', e);
    } finally {
      this.writing = false;
    }
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
