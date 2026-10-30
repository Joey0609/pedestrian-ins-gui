// The firmware uses distinct WebSocket and USB payloads; reject unknown layouts.
(function (root) {
  const BMI088_NUM = 4;
  function decodeIMUData(message) {
    if (!message || typeof message.data !== 'string') return null;
    try {
      const binary = atob(message.data);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const view = new DataView(bytes.buffer);
      const size = bytes.length;
      const hasType = message.type !== undefined && message.type !== null;
      const type = hasType ? Number(message.type) : 1;
      let family;
      if (message.protocol === 'all_sensors') family = 'all_sensors';
      else if (message.protocol && message.protocol !== 'bmi088') return null;
      else if (message.protocol === 'bmi088') family = 'bmi088';
      else if (type === 1 && size === 192) family = 'all_sensors';
      else if ((type === 1 && (size === 773 || size === 776)) ||
               (type === 2 && (size === 100 || size === 104)) ||
               (type === 3 && size === 88)) family = 'bmi088';
      else return null;

      const valid = family === 'all_sensors'
        ? (type === 1 && size === 192) || (type === 2 && size === 136) || (type === 3 && size === 120)
        : (type === 1 && (size === 773 || size === 776)) || (type === 2 && (size === 100 || size === 104)) || (type === 3 && size === 88);
      if (!valid) return null;
      let offset = 0;
      const timestamp = Number(view.getBigUint64(offset, true)); offset += 8;
      const scalar = () => { const v = view.getFloat32(offset, true); offset += 4; return v; };
      const vector = n => Array.from({length: n}, scalar);
      const vectors = (n, d) => Array.from({length: n}, () => vector(d));
      const count = family === 'bmi088' && type === 1 ? 5 : 1;
      const result = { timestamp, protocolFamily: family, raw_accel: vectors(count, 3), raw_gyro: vectors(count, 3),
        raw_temp: vector(count), quat: vectors(count, 4) };
      if (type === 1) result.rotation_matrix = vectors(count, 9);
      result.eular = vectors(count, 3);
      result.linear_accel = vectors(count, 3);
      result.earth_accel = vectors(count, 3);
      if (type === 1) {
        result.kf_accel = vectors(count, 3);
        result.kf_velocity = vectors(count, 3);
        result.displacement = vectors(count, 3);
      } else if (type === 2) result.displacement = vectors(count, 3);
      if (family === 'all_sensors') {
        result.magnetic_field = [vector(3)];
        result.baro_temperature_c = [scalar()];
        result.baro_pressure_pa = [scalar()];
        if (!hasType) {
          // USB sends IMU_Data; floor comes before the status bytes.
          result.estimated_floor = [view.getInt32(offset, true)]; offset += 4;
          result.stationary = [view.getUint8(offset++) !== 0];
          result.lis2mdl_ready = view.getUint8(offset++) !== 0;
          result.bmp390l_ready = view.getUint8(offset++) !== 0;
        } else {
          if (type === 1) result.stationary = [view.getUint8(offset++) !== 0];
          result.lis2mdl_ready = view.getUint8(offset++) !== 0;
          result.bmp390l_ready = view.getUint8(offset++) !== 0;
          offset = type === 1 ? 184 : type === 2 ? 128 : 112;
          result.estimated_floor = [view.getInt32(offset, true)];
        }
      } else if (type === 1) {
        result.stationary = Array.from({length: count}, () => view.getUint8(offset++) !== 0);
      }
      return result;
    } catch (_) { return null; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { decodeIMUData, BMI088_NUM };
  else root.IMUDataProcessor = { decodeIMUData, BMI088_NUM };
})(typeof window !== 'undefined' ? window : globalThis);
