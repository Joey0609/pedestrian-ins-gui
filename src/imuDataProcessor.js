// Firmware payload decoder.
//
// Two device families share one WebSocket envelope
//   {"ts":<us>,"type":1|2|3,"battery":<int>,"data":"<base64 payload>"}
// but their binary payloads differ in both fields and byte length:
//
//   bmi088       4 × BMI088 + one averaged slot   → 5 sensor slots on type 1
//   all_sensors  1 × BMI088 + LIS2MDL + BMP390L   → always 1 sensor slot
//
// Layout is derived from (protocol, type, payload size) instead of hardcoded
// lengths, so firmware variants (with or without the floor extension) all decode.
(function (root) {
  const BMI088_NUM = 4;

  // Field blocks in wire order. `dims` is the number of floats per sensor.
  const FIELD = {
    raw_accel: 3,
    raw_gyro: 3,
    raw_temp: 1,
    quat: 4,
    rotation_matrix: 9,
    eular: 3,
    linear_accel: 3,
    earth_accel: 3,
    kf_accel: 3,
    kf_velocity: 3,
    displacement: 3,
  };

  const BMI088_TYPE1_FIELDS = ['raw_accel', 'raw_gyro', 'raw_temp', 'quat', 'rotation_matrix',
    'eular', 'linear_accel', 'earth_accel', 'kf_accel', 'kf_velocity', 'displacement'];
  const BMI088_TYPE2_FIELDS = ['raw_accel', 'raw_gyro', 'raw_temp', 'quat', 'eular',
    'linear_accel', 'earth_accel', 'displacement'];
  const BMI088_TYPE3_FIELDS = ['raw_accel', 'raw_gyro', 'raw_temp', 'quat', 'eular',
    'linear_accel', 'earth_accel'];
  const ALL_SENSORS_TYPE1_FIELDS = BMI088_TYPE1_FIELDS;
  const ALL_SENSORS_TYPE2_FIELDS = BMI088_TYPE2_FIELDS;
  const ALL_SENSORS_TYPE3_FIELDS = BMI088_TYPE3_FIELDS;

  // Static description of a device family, used by the UI to render columns,
  // charts and settings without guessing.
  const FAMILIES = {
    bmi088: {
      family: 'bmi088',
      label: '4 × BMI088',
      detail: '4 × BMI088 + 均值通道',
      sensorOptions: ['sensor0', 'sensor1', 'sensor2', 'sensor3', '平均'],
      hasMag: false,
      hasBaro: false,
      hasFloor: false,
    },
    all_sensors: {
      family: 'all_sensors',
      label: 'BMI088 + LIS2MDL + BMP390L',
      detail: '1 × BMI088 + LIS2MDL + BMP390L',
      sensorOptions: ['sensor0'],
      hasMag: true,
      hasBaro: true,
      hasFloor: false,
    },
  };

  function floatBytes(n) { return n * 4; }

  function sensorsFor(family, type) {
    if (family === 'bmi088' && type === 1) return 5;
    return 1;
  }

  // Byte size of the common prefix (timestamp + all sensor fields) for a layout.
  function prefixSize(family, type) {
    const fields = fieldsFor(family, type);
    const count = sensorsFor(family, type);
    let sum = 8; // timestamp
    for (const name of fields) sum += floatBytes(FIELD[name]) * count;
    return sum;
  }

  function fieldsFor(family, type) {
    if (family === 'bmi088') {
      if (type === 1) return BMI088_TYPE1_FIELDS;
      if (type === 2) return BMI088_TYPE2_FIELDS;
      return BMI088_TYPE3_FIELDS;
    }
    if (type === 1) return ALL_SENSORS_TYPE1_FIELDS;
    if (type === 2) return ALL_SENSORS_TYPE2_FIELDS;
    return ALL_SENSORS_TYPE3_FIELDS;
  }

  // Known tails per family/type. `flagBytes` covers stationary/ready flags,
  // `tailBytes` the fixed padding that follows them.
  function tailFor(family, type) {
    if (family === 'bmi088') {
      return { externalBytes: 0, flagBytes: type === 1 ? 5 : 0, floor: false };
    }
    return { externalBytes: 20, flagBytes: type === 1 ? 4 : (type === 2 ? 8 : 4), floor: true };
  }

  function expectedSize(family, type, withFloor) {
    const tail = tailFor(family, type);
    return prefixSize(family, type) + tail.externalBytes + tail.flagBytes + (withFloor ? 4 : 0);
  }

  // Accepted payload sizes → layout descriptor.
  const LAYOUTS = (() => {
    const list = [];
    for (const family of ['bmi088', 'all_sensors']) {
      for (const type of [1, 2, 3]) {
        const base = expectedSize(family, type, false);
        list.push({ family, type, withFloor: false, size: base, baseSize: base });
        if (family === 'all_sensors') {
          // Firmware variants that append the estimated floor (int32) after the
          // base layout, optionally followed by alignment padding.
          list.push({ family, type, withFloor: true, size: base + 4, baseSize: base });
          list.push({ family, type, withFloor: true, size: base + 8, baseSize: base });
        } else if (type === 1) {
          // bool[5] tail can be padded to 8-byte alignment by the compiler.
          list.push({ family, type, withFloor: false, size: base + 3, baseSize: base, padded: true });
        } else if (type === 2) {
          list.push({ family, type, withFloor: false, size: base + 4, baseSize: base, padded: true });
        }
      }
    }
    return list;
  })();

  function resolveLayout(protocol, type, size) {
    const allowedFamilies = protocol === 'all_sensors' || protocol === 'bmi088'
      ? [protocol]
      : ['bmi088', 'all_sensors'];
    for (const family of allowedFamilies) {
      const hit = LAYOUTS.find((l) => l.family === family && l.type === type && l.size === size);
      if (hit) return hit;
    }
    return null;
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function decodeIMUData(message) {
    if (!message || typeof message.data !== 'string') return null;
    try {
      const bytes = base64ToBytes(message.data);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = bytes.length;
      const hasType = message.type !== undefined && message.type !== null;
      const type = hasType ? Number(message.type) : 1;
      const layout = resolveLayout(message.protocol, type, size);
      if (!layout) {
        if (typeof console !== 'undefined') {
          console.warn('[imu] unknown payload', { protocol: message.protocol, type: message.type, size });
        }
        return null;
      }

      const { family } = layout;
      const count = sensorsFor(family, type);
      let offset = 0;
      const scalar = () => { const v = view.getFloat32(offset, true); offset += 4; return v; };
      const vector = (n) => Array.from({ length: n }, scalar);
      const vectors = (n, d) => Array.from({ length: n }, () => vector(d));

      const timestamp = Number(view.getBigUint64(offset, true)); offset += 8;
      const result = {
        timestamp,
        protocolFamily: family,
        packetType: type,
        sensorCount: count,
        capabilities: { ...FAMILIES[family], hasFloor: layout.withFloor },
      };

      for (const name of fieldsFor(family, type)) {
        const dims = FIELD[name];
        result[name] = dims === 1 ? vector(count) : vectors(count, dims);
      }

      if (family === 'all_sensors') {
        result.magnetic_field = [vector(3)];
        result.baro_temperature_c = [scalar()];
        result.baro_pressure_pa = [scalar()];
        if (type === 1) result.stationary = [view.getUint8(offset++) !== 0];
        result.lis2mdl_ready = [view.getUint8(offset++) !== 0];
        result.bmp390l_ready = [view.getUint8(offset++) !== 0];
        if (layout.withFloor) {
          // The floor extension always starts at the end of the base layout
          // (184 / 128 / 112), after the reserved flag padding.
          const floorOffset = layout.baseSize;
          if (floorOffset + 4 <= size) {
            result.estimated_floor = [view.getInt32(floorOffset, true)];
            result.capabilities.hasFloor = true;
          }
        }
      } else if (type === 1) {
        result.stationary = Array.from({ length: count }, () => view.getUint8(offset++) !== 0);
      }

      return result;
    } catch (_) {
      return null;
    }
  }

  const api = {
    decodeIMUData,
    BMI088_NUM,
    FAMILIES,
    getFamilyInfo: (family) => FAMILIES[family] || null,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.IMUDataProcessor = api;
})(typeof window !== 'undefined' ? window : globalThis);
