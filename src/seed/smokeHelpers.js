const crypto = require("crypto");

const clientRequestId = () => crypto.randomUUID();

module.exports = {
  clientRequestId,
};
