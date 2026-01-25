// imuDataProcessor.js
// Shared IMU data processing logic for both renderer and imupage

const BMI088_NUM = 4; // 0..3 actual sensors, 4 is combined/average

/**
 * Decode Base64 encoded IMU data and parse binary format
 * @param {Object} data - Message object with data.data containing Base64 string
 * @returns {Object} Parsed IMU data object or null on error
 */
function decodeIMUData(data) {
  if (!data || !data.data || typeof data.data !== 'string') {
    return null;
  }

  try {
    // Decode Base64 data
    const binaryString = atob(data.data);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Parse binary data using DataView
    const view = new DataView(bytes.buffer);
    let offset = 0;

    // Parse timestamp (8 bytes)
    const timestamp = view.getBigUint64(offset, true); // Little-endian
    offset += 8;

    // Helper: Parse sensor array
    const parseSensorArray = (count, dimensions) => {
      const result = [];
      for (let s = 0; s < count; s++) {
        const sensorData = [];
        for (let d = 0; d < dimensions; d++) {
          sensorData.push(view.getFloat32(offset, true)); // Little-endian
          offset += 4;
        }
        result.push(sensorData);
      }
      return result;
    };

    // Helper: Parse scalar array
    const parseScalarArray = (count) => {
      const result = [];
      for (let i = 0; i < count; i++) {
        result.push(view.getFloat32(offset, true));
        offset += 4;
      }
      return result;
    };

    // Helper: Parse boolean array
    const parseBoolArray = (count) => {
      const result = [];
      for (let i = 0; i < count; i++) {
        result.push(view.getUint8(offset) !== 0);
        offset += 1;
      }
      return result;
    };

    // Parse all IMU data fields
    const imuData = {
      timestamp: Number(timestamp),
      raw_accel: parseSensorArray(BMI088_NUM + 1, 3),
      raw_gyro: parseSensorArray(BMI088_NUM + 1, 3),
      raw_temp: parseScalarArray(BMI088_NUM + 1),
      quat: parseSensorArray(BMI088_NUM + 1, 4),
      rotation_matrix: parseSensorArray(BMI088_NUM + 1, 9),
      eular: parseSensorArray(BMI088_NUM + 1, 3),
      linear_accel: parseSensorArray(BMI088_NUM + 1, 3),
      earth_accel: parseSensorArray(BMI088_NUM + 1, 3),
      kf_accel: parseSensorArray(BMI088_NUM + 1, 3),
      kf_velocity: parseSensorArray(BMI088_NUM + 1, 3),
      displacement: parseSensorArray(BMI088_NUM + 1, 3),
      stationary: parseBoolArray(BMI088_NUM + 1)
    };

    return imuData;
  } catch (error) {
    console.error("Base64 decoding failed:", error);
    return null;
  }
}

// Export for use in different contexts
if (typeof module !== 'undefined' && module.exports) {
  // Node.js / CommonJS
  module.exports = { decodeIMUData, BMI088_NUM };
} else if (typeof window !== 'undefined') {
  // Browser
  window.IMUDataProcessor = { decodeIMUData, BMI088_NUM };
}
